import assert from "node:assert/strict";
import { test } from "node:test";

import { compactMessages, estimateTokens, shrinkMessages } from "../src/context.js";
import type { OpenAiCompatibleProvider } from "../src/provider.js";
import type { ChatMessage } from "../src/types.js";

const signal = new AbortController().signal;

function providerReturning(content: string): OpenAiCompatibleProvider {
  return {
    model: "fake",
    async complete() {
      return { content, reasoning: "", toolCalls: [], usage: undefined, finishReason: "stop" };
    },
  } as unknown as OpenAiCompatibleProvider;
}

function longHistory(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "do the task" },
  ];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `c${index}`, name: "bash", arguments: '{"command":"true"}' }],
    });
    messages.push({ role: "tool", tool_call_id: `c${index}`, content: "x".repeat(2_000) });
  }
  messages.push({ role: "assistant", content: "the latest step" });
  return messages;
}

test("estimates more tokens for more content", () => {
  const small = estimateTokens([{ role: "user", content: "hi" }]);
  const large = estimateTokens([{ role: "user", content: "x".repeat(10_000) }]);
  assert.ok(large > small + 2_000);
});

test("summarizes the middle, keeps the task and the recent tail", async () => {
  const messages = longHistory();
  const result = await compactMessages({
    provider: providerReturning("SUMMARY OF EARLIER WORK"),
    messages,
    signal,
  });

  assert.equal(result.summarized, true);
  assert.equal(result.changed, true);
  assert.equal(result.messages[0]?.content, "system prompt");
  assert.equal(result.messages[1]?.content, "do the task");
  assert.match(String(result.messages[2]?.content), /SUMMARY OF EARLIER WORK/);
  assert.equal(result.messages.at(-1)?.content, "the latest step");
  assert.ok(result.messages.length < messages.length);
});

test("never leaves a tool result without its call", async () => {
  const result = await compactMessages({
    provider: providerReturning("summary"),
    messages: longHistory(),
    signal,
  });

  const known = new Set<string>();
  for (const message of result.messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) known.add(call.id);
    }
    if (message.role === "tool") {
      assert.ok(known.has(message.tool_call_id ?? ""), "orphaned tool result");
    }
  }
});

test("falls back to dropping history when summarization fails", async () => {
  const failing = {
    model: "fake",
    async complete() {
      throw new Error("summarizer down");
    },
  } as unknown as OpenAiCompatibleProvider;

  const result = await compactMessages({ provider: failing, messages: longHistory(), signal });
  assert.equal(result.dropped, true);
  assert.equal(result.changed, true);
  assert.match(String(result.messages[2]?.content), /dropped to fit the context/);
});

test("does nothing when only the task and a short tail exist", async () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "t" },
    { role: "assistant", content: "a" },
  ];
  const result = await compactMessages({ provider: providerReturning("x"), messages, signal });
  assert.equal(result.changed, false);
  assert.deepEqual(result.messages, messages);
});

test("shrinkMessages bounds every message and drops reasoning", () => {
  const shrunk = shrinkMessages([
    { role: "tool", tool_call_id: "c1", content: "y".repeat(10_000), reasoning_content: "secret" },
  ]);
  assert.ok((shrunk[0]?.content ?? "").length < 5_000);
  assert.equal(shrunk[0]?.reasoning_content, undefined);
});
