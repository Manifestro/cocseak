import { relative } from "node:path";

import { ProviderError, TimeoutError } from "./errors.js";
import type { KapAdapter } from "./kap.js";
import type { OpenAiCompatibleProvider } from "./provider.js";
import type { SessionLog } from "./session.js";
import type { ChatMessage, ToolCall, ToolSchema, Usage } from "./types.js";
import type { ChangeTrace, CommandTrace, DecisionTrace } from "./report.js";
import type { Tool, ToolResult } from "./tools/types.js";
import { errorResult } from "./tools/types.js";
import { findTool, hookNameFor, toolSchemas } from "./tools/index.js";
import { compactMessages, compactThreshold, estimateTokens, shrinkMessages } from "./context.js";

export type AgentEvent =
  | { type: "turn"; turn: number }
  | { type: "assistant_text"; text: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; output: string; isError: boolean }
  | { type: "compact"; before: number; after: number; summarized: boolean };

export interface AgentOptions {
  provider: OpenAiCompatibleProvider;
  tools: readonly Tool[];
  systemPrompt: string;
  task: string;
  cwd: string;
  title: string;
  maxTurns: number;
  contextTokens: number;
  signal: AbortSignal;
  session: SessionLog;
  kap: KapAdapter;
  /** The conversation of an earlier run to continue, without its system prompt. */
  history?: readonly ChatMessage[];
  /** The run `history` comes from. */
  resumedFrom?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentPartial {
  turns: number;
  usage: Usage;
  compactions: number;
}

export interface AgentResult {
  answer: string;
  /** The model used every turn; `answer` is the report it wrote in the extra wrap-up turn. */
  limitReached: boolean;
  turns: number;
  usage: Usage;
  compactions: number;
  commands: CommandTrace[];
  decisions: DecisionTrace[];
  changed: ChangeTrace[];
}

/**
 * The whole harness: model turn → tool calls → tool results → model turn, until the model answers
 * without calling a tool. Every step is mirrored to the session log and, when active, to KAP.
 */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { provider, tools, session, kap } = options;
  const schemas: ToolSchema[] = toolSchemas(tools);
  const history = options.history ?? [];
  const messages: ChatMessage[] = [{ role: "system", content: options.systemPrompt }, ...history];

  session.append({
    type: "run_start",
    time: Date.now(),
    run_id: session.runId,
    title: options.title,
    task: options.task,
    model: provider.model,
    cwd: options.cwd,
    ...(options.resumedFrom ? { resumed_from: options.resumedFrom } : {}),
  });
  if (history.length > 0) {
    session.append({ type: "history", time: Date.now(), messages: [...history] });
  }

  // Every message is logged as it joins the conversation, so `--resume` can rebuild it exactly.
  const push = (message: ChatMessage): void => {
    messages.push(message);
    session.append({ type: "message", time: Date.now(), message });
  };
  push({ role: "user", content: options.task });

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const trace: { commands: CommandTrace[]; decisions: DecisionTrace[]; changed: ChangeTrace[] } = {
    commands: [],
    decisions: [],
    changed: [],
  };
  const threshold = compactThreshold(options.contextTokens);
  let compactions = 0;
  let turns = 0;
  let answer = "";
  let lastSummaryTurn = -10;
  let lastCallSignature = "";
  let repeatedCalls = 0;
  let reminded = false;
  const remindAt = Math.max(1, Math.floor(options.maxTurns * REMIND_AT));

  try {
    while (turns < options.maxTurns) {
      if (options.signal.aborted) throw new TimeoutError("run timed out");

      if (estimateTokens(messages) > threshold) {
        const before = estimateTokens(messages);
        const compacted = await compactMessages({
          provider,
          messages,
          signal: options.signal,
          summarize: turns - lastSummaryTurn >= 2,
        });
        if (compacted.summarized) lastSummaryTurn = turns;
        messages.length = 0;
        messages.push(...compacted.messages);
        if (compacted.usage) addUsage(usage, compacted.usage);

        // A summary can still leave a single huge tool result over the line.
        if (estimateTokens(messages) > threshold) {
          const shrunk = shrinkMessages(messages);
          messages.length = 0;
          messages.push(...shrunk);
        }

        const after = estimateTokens(messages);
        if (after < before) {
          compactions += 1;
          session.append({ type: "history", time: Date.now(), messages: messages.slice(1) });
          options.onEvent?.({ type: "compact", before, after, summarized: compacted.summarized });
        }
      }

      // A model that does not know its budget never starts to wrap up; tell it once, near the end.
      if (!reminded && options.maxTurns >= 5 && turns >= remindAt) {
        reminded = true;
        const left = options.maxTurns - turns;
        push({
          role: "user",
          content:
            `[cocseak] ${left} of ${options.maxTurns} turns left. Finish the change now: no more ` +
            "exploring or polishing, run the final check once, then reply with the report.",
        });
      }

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

      if (turn.finishReason === "length") {
        throw new ProviderError(
          "the model hit its output limit before finishing; narrow the task or raise max_tokens at the provider",
        );
      }

      if (turn.toolCalls.length === 0) {
        answer = turn.content.trim();
        push({ role: "assistant", content: turn.content });
        break;
      }

      push({
        role: "assistant",
        content: turn.content === "" ? null : turn.content,
        tool_calls: turn.toolCalls,
        ...(turn.reasoning !== "" ? { reasoning_content: turn.reasoning } : {}),
      });

      for (const call of turn.toolCalls) {
        const signature = `${call.name}\u0000${call.arguments}`;
        if (signature === lastCallSignature) {
          repeatedCalls += 1;
        } else {
          lastCallSignature = signature;
          repeatedCalls = 0;
        }
        if (repeatedCalls >= 6) {
          throw new ProviderError(
            `the model repeated the same ${call.name} call ${repeatedCalls + 1} times in a row; stopping to avoid a loop`,
          );
        }

        const result = await executeTool(call, tools, options, trace);
        push({ role: "tool", tool_call_id: call.id, content: result.output });
      }
    }

    let limitReached = false;
    if (answer === "") {
      if (turns >= options.maxTurns) {
        // Out of turns is not out of work: one more turn, without tools, for the report, so the
        // caller learns what was done and the work can still be committed.
        limitReached = true;
        answer = await wrapUp(options, messages, push, usage);
      } else {
        answer = "(the model finished without an answer)";
      }
    }

    session.append({
      type: "run_end",
      time: Date.now(),
      ok: true,
      turns,
      usage,
      answer,
      ...(limitReached ? { error: `turn limit of ${options.maxTurns} reached` } : {}),
    });

    return { answer, limitReached, turns, usage, compactions, ...trace };
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
    if (error instanceof Error) {
      (error as Error & { partial?: AgentPartial }).partial = { turns, usage, compactions };
    }
    throw error;
  } finally {
    await kap.stop();
    await session.flush();
  }
}

/** Share of the turn budget after which the model is told to wrap up. */
const REMIND_AT = 0.8;

const WRAP_UP =
  "[cocseak] The turn limit is reached and tools are now off. Write the final report: what you " +
  "changed, what you verified and how, and exactly what is left undone.";

async function wrapUp(
  options: AgentOptions,
  messages: ChatMessage[],
  push: (message: ChatMessage) => void,
  usage: Usage,
): Promise<string> {
  push({ role: "user", content: WRAP_UP });
  try {
    const turn = await options.provider.complete(
      messages,
      toolSchemas(options.tools),
      undefined,
      options.signal,
      "none",
    );
    addUsage(usage, turn.usage);
    const report = turn.content.trim();
    if (report !== "") {
      push({ role: "assistant", content: turn.content });
      return report;
    }
  } catch {
    // The report is a courtesy; the work and its record stand without it.
  }
  return `(turn limit of ${options.maxTurns} reached; the model wrote no report)`;
}

async function executeTool(
  call: ToolCall,
  tools: readonly Tool[],
  options: AgentOptions,
  trace: { commands: CommandTrace[]; decisions: DecisionTrace[]; changed: ChangeTrace[] },
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

  const startedAt = Date.now();
  const result = await runTool(call, tools, options);
  const durationMs = Date.now() - startedAt;

  recordTrace(trace, call, result, durationMs, options.cwd);

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

function recordTrace(
  trace: { commands: CommandTrace[]; decisions: DecisionTrace[]; changed: ChangeTrace[] },
  call: ToolCall,
  result: ToolResult,
  durationMs: number,
  cwd: string,
): void {
  const hook = result.hook;
  if (hook?.toolName === "Bash") {
    const command = typeof hook.toolInput.command === "string" ? hook.toolInput.command : call.name;
    trace.commands.push({ command, exit_code: result.exitCode, duration_ms: durationMs });
  }
  if (hook?.toolName === "Write" || hook?.toolName === "Edit") {
    const file = typeof hook.toolInput.file_path === "string" ? hook.toolInput.file_path : "";
    if (file !== "") {
      trace.changed.push({
        path: relative(cwd, file) || file,
        action: hook.toolName === "Write" ? "write" : "edit",
      });
    }
  }
  if (result.decision) trace.decisions.push(result.decision);
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
