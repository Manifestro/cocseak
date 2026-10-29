import { MaxTurnsError, TimeoutError } from "./errors.js";
import type { KapAdapter } from "./kap.js";
import type { OpenAiCompatibleProvider } from "./provider.js";
import type { SessionLog } from "./session.js";
import type { ChatMessage, ToolCall, ToolSchema, Usage } from "./types.js";
import type { Tool, ToolResult } from "./tools/types.js";
import { errorResult } from "./tools/types.js";
import { findTool, hookNameFor, toolSchemas } from "./tools/index.js";

export type AgentEvent =
  | { type: "turn"; turn: number }
  | { type: "assistant_text"; text: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; output: string; isError: boolean };

export interface AgentOptions {
  provider: OpenAiCompatibleProvider;
  tools: readonly Tool[];
  systemPrompt: string;
  task: string;
  cwd: string;
  title: string;
  maxTurns: number;
  signal: AbortSignal;
  session: SessionLog;
  kap: KapAdapter;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  answer: string;
  turns: number;
  usage: Usage;
}

/**
 * The whole harness: model turn → tool calls → tool results → model turn, until the model answers
 * without calling a tool. Every step is mirrored to the session log and, when active, to KAP.
 */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { provider, tools, session, kap } = options;
  const schemas: ToolSchema[] = toolSchemas(tools);
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.task },
  ];

  session.append({
    type: "run_start",
    time: Date.now(),
    run_id: session.runId,
    title: options.title,
    task: options.task,
    model: provider.model,
    cwd: options.cwd,
  });

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let turns = 0;
  let answer = "";

  try {
    while (turns < options.maxTurns) {
      if (options.signal.aborted) throw new TimeoutError("run timed out");
      turns += 1;
      options.onEvent?.({ type: "turn", turn: turns });

      let turn;
      try {
        turn = await provider.complete(
          messages,
          schemas,
          (text) => {
            options.onEvent?.({ type: "assistant_text", text });
          },
          options.signal,
        );
      } catch (error) {
        if (options.signal.aborted) throw new TimeoutError("run timed out");
        throw error;
      }

      addUsage(usage, turn.usage);

      if (turn.toolCalls.length === 0) {
        answer = turn.content.trim();
        break;
      }

      messages.push({
        role: "assistant",
        content: turn.content === "" ? null : turn.content,
        tool_calls: turn.toolCalls,
        ...(turn.reasoning !== "" ? { reasoning_content: turn.reasoning } : {}),
      });

      for (const call of turn.toolCalls) {
        const result = await executeTool(call, tools, options);
        messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
      }
    }

    if (answer === "") {
      if (turns >= options.maxTurns) {
        throw new MaxTurnsError(`model did not finish within ${options.maxTurns} turns`);
      }
      answer = "(the model finished without an answer)";
    }

    session.append({
      type: "run_end",
      time: Date.now(),
      ok: true,
      turns,
      usage,
      answer,
    });

    return { answer, turns, usage };
  } catch (error) {
    session.append({
      type: "run_end",
      time: Date.now(),
      ok: false,
      turns,
      usage,
      answer,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await kap.stop();
    await session.flush();
  }
}

async function executeTool(
  call: ToolCall,
  tools: readonly Tool[],
  options: AgentOptions,
): Promise<ToolResult> {
  const { session, kap } = options;

  session.append({
    type: "tool_call",
    time: Date.now(),
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  });
  options.onEvent?.({ type: "tool_start", name: call.name, args: call.arguments });

  const result = await runTool(call, tools, options);

  session.append({
    type: "tool_result",
    time: Date.now(),
    call_id: call.id,
    name: call.name,
    output: result.output,
    exit_code: result.exitCode,
    is_error: result.isError,
  });

  if (result.decision) {
    session.append({
      type: "decision",
      time: Date.now(),
      summary: result.decision.summary,
      rationale: result.decision.rationale,
      alternatives: result.decision.alternatives,
    });
  }

  if (result.hook) {
    await kap.postToolUse(call.id, result.hook);
  }

  options.onEvent?.({
    type: "tool_end",
    name: call.name,
    output: result.output,
    isError: result.isError,
  });

  return result;
}

async function runTool(
  call: ToolCall,
  tools: readonly Tool[],
  options: AgentOptions,
): Promise<ToolResult> {
  const tool = findTool(call.name, tools);
  if (!tool) {
    const result = errorResult(
      `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(", ")}.`,
    );
    result.hook = { toolName: call.name, toolInput: {}, toolResponse: {}, failed: true };
    return result;
  }

  let args: Record<string, unknown>;
  try {
    args = parseArguments(call.arguments);
  } catch (error) {
    const result = errorResult(
      `Arguments for "${call.name}" are not valid JSON: ${(error as Error).message}`,
    );
    result.hook = { toolName: hookNameFor(call.name), toolInput: {}, toolResponse: {}, failed: true };
    return result;
  }

  try {
    return await tool.run(args, { cwd: options.cwd, kap: options.kap, signal: options.signal });
  } catch (error) {
    const result = errorResult(error instanceof Error ? error.message : String(error));
    result.hook = { toolName: hookNameFor(call.name), toolInput: {}, toolResponse: {}, failed: true };
    return result;
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function addUsage(total: Usage, turn: Usage | undefined): void {
  if (!turn) return;
  total.prompt_tokens = (total.prompt_tokens ?? 0) + (turn.prompt_tokens ?? 0);
  total.completion_tokens = (total.completion_tokens ?? 0) + (turn.completion_tokens ?? 0);
  total.total_tokens = (total.total_tokens ?? 0) + (turn.total_tokens ?? 0);
}
