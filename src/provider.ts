import { chatCompletionsUrl } from "./config.js";
import { ProviderError } from "./errors.js";
import type { AssistantTurn, ChatMessage, ToolCall, ToolSchema, Usage } from "./types.js";

export interface ProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injected only in tests. */
  fetchImpl?: typeof fetch;
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface Chunk {
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: Usage;
  error?: { message?: string; type?: string };
}

/**
 * A client for the subset of the OpenAI chat-completions API that a coding harness needs:
 * streaming, tool calls, and reasoning-model extras (DeepSeek's `reasoning_content`).
 *
 * Deliberately dependency-free: `fetch` ships with Node.
 */
export class OpenAiCompatibleProvider {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProviderOptions) {
    this.url = chatCompletionsUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * One model turn. Streams text through `onDelta` as it arrives and returns the assembled turn,
   * including any tool calls the model wants to make.
   */
  async complete(
    messages: readonly ChatMessage[],
    tools: readonly ToolSchema[],
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ProviderError(
        `Could not reach the model provider at ${this.url}: ${messageOf(error)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Provider returned HTTP ${response.status}${text ? `: ${truncate(text, 2000)}` : ""}`,
        response.status,
        text,
      );
    }
    if (!response.body) {
      throw new ProviderError("Provider returned an empty response body");
    }

    return this.consume(response.body, onDelta);
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    onDelta?: (text: string) => void,
  ): Promise<AssistantTurn> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    const partial = new Map<number, { id: string; name: string; arguments: string }>();

    const handleLine = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") return;

      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload) as Chunk;
      } catch {
        return; // A malformed keep-alive fragment is not worth failing the run.
      }
      if (chunk.error) {
        throw new ProviderError(`Provider error: ${chunk.error.message ?? "unknown"}`);
      }
      if (chunk.usage) usage = chunk.usage;

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content !== "") {
          content += delta.content;
          onDelta?.(delta.content);
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
          reasoning += delta.reasoning_content;
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const entry = partial.get(index) ?? { id: "", name: "", arguments: "" };
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.name += call.function.name;
          if (call.function?.arguments) entry.arguments += call.function.arguments;
          partial.set(index, entry);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    handleLine(buffer.replace(/\r$/, ""));

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call], position) => ({
        id: call.id !== "" ? call.id : `call_${position}_${index}`,
        name: call.name,
        arguments: call.arguments !== "" ? call.arguments : "{}",
      }));

    return { content, reasoning, toolCalls, usage, finishReason };
  }
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role };
  if (message.content !== null && message.content !== undefined) wire.content = message.content;
  if (message.tool_calls && message.tool_calls.length > 0) {
    wire.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
  // `reasoning_content` is intentionally never sent back: DeepSeek rejects it on input.
  return wire;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}
