import { chatCompletionsUrl } from "./config.js";
import { ProviderError } from "./errors.js";
import type { AssistantTurn, ChatMessage, ToolCall, ToolSchema, Usage } from "./types.js";

export interface ProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Total attempts, including the first one. */
  attempts?: number;
  /** Base delay between retries; doubles each attempt. */
  backoffMs?: number;
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

interface CompletionMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface CompletionResponse {
  choices?: Array<{ message?: CompletionMessage; finish_reason?: string | null }>;
  usage?: Usage;
  error?: { message?: string };
}

const DEFAULT_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * A client for the subset of the OpenAI chat-completions API that a coding harness needs:
 * streaming, tool calls, and reasoning-model extras (DeepSeek's `reasoning_content`).
 *
 * Deliberately dependency-free: `fetch` ships with Node. Transient failures (429, 5xx, network)
 * are retried with backoff; a provider that ignores `stream` and answers with plain JSON is
 * still understood.
 */
export class OpenAiCompatibleProvider {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(options: ProviderOptions) {
    this.url = chatCompletionsUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    this.backoffMs = options.backoffMs ?? 500;
  }

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

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (signal?.aborted) throw new ProviderError("request aborted");
      try {
        return await this.once(body, onDelta, signal);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError && error.retryable;
        if (!retryable || attempt === this.attempts) throw error;

        const wait =
          error instanceof ProviderError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : Math.min(this.backoffMs * 2 ** (attempt - 1), 4_000);
        await sleep(wait, signal);
      }
    }
    throw lastError;
  }

  private async once(
    body: Record<string, unknown>,
    onDelta: ((text: string) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AssistantTurn> {
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
      if (signal?.aborted) throw new ProviderError("request aborted");
      throw new ProviderError(
        `Could not reach the model provider at ${this.url}: ${messageOf(error)}`,
        undefined,
        undefined,
        { retryable: true },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      throw new ProviderError(
        `Provider returned HTTP ${response.status}${text ? `: ${truncate(text, 2000)}` : ""}`,
        response.status,
        text,
        { retryable: RETRYABLE_STATUS.has(response.status), retryAfterMs: retryAfter },
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return this.fromJson(response, contentType);
    }
    if (!response.body) {
      throw new ProviderError("Provider returned an empty response body");
    }
    return this.consume(response.body, onDelta);
  }

  /** Some compatible servers ignore `stream: true` and answer with a plain JSON body. */
  private async fromJson(response: Response, contentType: string): Promise<AssistantTurn> {
    const text = await response.text().catch(() => "");
    let payload: CompletionResponse;
    try {
      payload = JSON.parse(text) as CompletionResponse;
    } catch {
      throw new ProviderError(
        `Provider answered with ${contentType || "an unknown content type"} instead of an event stream: ${truncate(text, 500)}`,
      );
    }
    if (payload.error) {
      throw new ProviderError(`Provider error: ${payload.error.message ?? "unknown"}`);
    }

    const choice = payload.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }));

    return {
      content: message.content ?? "",
      reasoning: message.reasoning_content ?? "",
      toolCalls,
      usage: payload.usage,
      finishReason: choice?.finish_reason ?? undefined,
    };
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
    let parsedChunks = 0;
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
      parsedChunks += 1;
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
          if (call.function?.name) entry.name = call.function.name;
          if (call.function?.arguments) entry.arguments += call.function.arguments;
          partial.set(index, entry);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    };

    try {
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
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }

    if (parsedChunks === 0 && content === "" && partial.size === 0) {
      throw new ProviderError("Provider streamed no data");
    }

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

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}
