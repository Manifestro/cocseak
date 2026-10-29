import type { OpenAiCompatibleProvider } from "./provider.js";
import type { ChatMessage, Usage } from "./types.js";

/** Compact before the model's window is full, not after it rejects the request. */
export const COMPACT_RATIO = 0.75;

/** How many recent messages stay verbatim. */
const KEEP_RECENT = 6;

/** A single message's share of the transcript sent to the summarizer. */
const TRANSCRIPT_CLIP = 2_000;

/** The summarizer's input cap; beyond this the middle of the history is dropped. */
const TRANSCRIPT_LIMIT = 120_000;

/** Messages kept when the summary call fails. */
const FALLBACK_MESSAGE_CLIP = 4_000;

const SUMMARY_INSTRUCTION = `You compress the transcript of a coding agent's run so it can continue
with less context. Preserve, concretely:
- the task and what has been done so far;
- decisions taken and why, including rejected alternatives;
- files created or changed;
- commands run and their results (exit codes, failures);
- how many times each step was repeated, and which step is next;
- what is still unfinished or uncertain.
Be terse and factual. No preamble, no markdown headers, at most 400 words.`;

/**
 * Token estimate without a tokenizer: messages carry more than their text (roles, JSON, tool
 * calls), and JavaScript string length is a poor proxy for tokens in mixed alphabets, so divide
 * pessimistically and add per-message overhead.
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    chars += message.reasoning_content?.length ?? 0;
    for (const call of message.tool_calls ?? []) {
      chars += call.name.length + call.arguments.length + 16;
    }
  }
  return Math.ceil(chars / 3.5) + messages.length * 8;
}

export function compactThreshold(contextTokens: number): number {
  return Math.floor(contextTokens * COMPACT_RATIO);
}

export interface CompactionResult {
  messages: ChatMessage[];
  usage: Usage | undefined;
  /** True when a model-written summary replaced the older history. */
  summarized: boolean;
  /** True when the history was dropped instead of summarized (the summary call failed). */
  dropped: boolean;
  /** False when there was nothing old enough to compact. */
  changed: boolean;
}

/**
 * Replace everything between the original task and the recent tail with a summary.
 *
 * The boundary never splits a tool call from its results: `split` is advanced past `tool`
 * messages, because a dangling tool result makes the next request invalid.
 */
export async function compactMessages(options: {
  provider: OpenAiCompatibleProvider;
  messages: readonly ChatMessage[];
  signal: AbortSignal;
  keepRecent?: number;
  /** False to skip the model call and leave the history to `shrinkMessages`. */
  summarize?: boolean;
}): Promise<CompactionResult> {
  const { provider, messages, signal } = options;
  const keepRecent = options.keepRecent ?? KEEP_RECENT;

  const system = messages[0];
  const task = messages[1];
  if (!system || !task) {
    return { messages: [...messages], usage: undefined, summarized: false, dropped: false, changed: false };
  }

  let split = Math.max(2, messages.length - keepRecent);
  while (split < messages.length && messages[split]?.role === "tool") split += 1;
  if (split <= 2) {
    return { messages: [...messages], usage: undefined, summarized: false, dropped: false, changed: false };
  }

  const recent = messages.slice(split);
  const older = messages.slice(2, split);

  if (options.summarize === false) {
    return { messages: [...messages], usage: undefined, summarized: false, dropped: false, changed: false };
  }

  try {
    const turn = await provider.complete(
      [
        { role: "system", content: SUMMARY_INSTRUCTION },
        { role: "user", content: renderTranscript(older) },
      ],
      [],
      undefined,
      signal,
    );
    const summary = turn.content.trim();
    if (summary === "") throw new Error("the summarizer returned nothing");

    return {
      messages: [system, task, { role: "user", content: `Earlier work in this run, summarized:\n${summary}` }, ...recent],
      usage: turn.usage,
      summarized: true,
      dropped: false,
      changed: true,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      messages: [
        system,
        task,
        { role: "user", content: "Earlier steps were dropped to fit the context window." },
        ...recent,
      ],
      usage: undefined,
      summarized: false,
      dropped: true,
      changed: true,
    };
  }
}

/** Last resort: shorten the remaining messages in place until they fit. */
export function shrinkMessages(messages: readonly ChatMessage[], limit = FALLBACK_MESSAGE_CLIP): ChatMessage[] {
  return messages.map((message) => {
    const next: ChatMessage = { ...message };
    if (next.content && next.content.length > limit) {
      const head = Math.floor(limit * 0.7);
      const tail = limit - head;
      next.content = `${next.content.slice(0, head)}\n… [truncated ${next.content.length - limit} chars] …\n${next.content.slice(-tail)}`;
    }
    if (next.tool_calls) {
      next.tool_calls = next.tool_calls.map((call) => ({
        ...call,
        arguments: call.arguments.length > limit ? call.arguments.slice(0, limit) : call.arguments,
      }));
    }
    delete next.reasoning_content;
    return next;
  });
}

function renderTranscript(messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      parts.push(`TOOL RESULT (${message.tool_call_id ?? "?"}):\n${clip(message.content ?? "", TRANSCRIPT_CLIP)}`);
      continue;
    }
    if (message.role === "assistant") {
      const calls = (message.tool_calls ?? [])
        .map((call) => `${call.name}(${clip(call.arguments, 400)})`)
        .join(", ");
      const text = clip(message.content ?? "", TRANSCRIPT_CLIP);
      parts.push(`ASSISTANT: ${text}${calls ? `\n  tool calls: ${calls}` : ""}`);
      continue;
    }
    parts.push(`${message.role.toUpperCase()}: ${clip(message.content ?? "", TRANSCRIPT_CLIP)}`);
  }

  let transcript = parts.join("\n\n");
  if (transcript.length > TRANSCRIPT_LIMIT) {
    const head = 40_000;
    const tail = TRANSCRIPT_LIMIT - head;
    transcript = `${transcript.slice(0, head)}\n… [earlier middle omitted] …\n${transcript.slice(-tail)}`;
  }
  return transcript;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} chars omitted]`;
}
