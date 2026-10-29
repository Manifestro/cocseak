import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.js";
import type { OpenAiCompatibleProvider } from "../src/provider.js";
import { newRunId, SessionLog } from "../src/session.js";
import { TOOLS } from "../src/tools/index.js";
import { KapAdapter } from "../src/kap.js";
import { tempDir } from "./helpers.js";

test("runs tool calls until the model answers and logs every step", async () => {
  const dir = tempDir();
  try {
    let turns = 0;
    const provider = {
      model: "fake-model",
      async complete() {
        turns += 1;
        if (turns === 1) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [{ id: "call_1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            finishReason: "tool_calls",
          };
        }
        return {
          content: "done",
          reasoning: "",
          toolCalls: [],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          finishReason: "stop",
        };
      },
    } as unknown as OpenAiCompatibleProvider;

    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });

    const result = await runAgent({
      provider,
      tools: TOOLS,
      systemPrompt: "test",
      task: "say hi",
      cwd: dir.path,
      title: "test",
      maxTurns: 5,
      signal: new AbortController().signal,
      session,
      kap,
    });

    assert.equal(result.answer, "done");
    assert.equal(result.turns, 2);
    assert.equal(result.usage.total_tokens, 5);

    await session.flush();
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(session.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    assert.deepEqual(
      lines.map((line) => line.type),
      [
        "run_start",
        "message", // the task
        "message", // the assistant turn with its tool call
        "tool_call",
        "tool_result",
        "message", // the tool result, as the model sees it
        "message", // the final answer
        "run_end",
      ],
    );
  } finally {
    dir.cleanup();
  }
});

test("at the turn limit the model is reminded, then reports without tools", async () => {
  const dir = tempDir();
  try {
    const seen: Array<{ choice: string; last: string }> = [];
    const provider = {
      model: "fake-model",
      async complete(messages: Array<{ content: string | null }>, _tools: unknown, _d: unknown, _s: unknown, choice = "auto") {
        seen.push({ choice, last: String(messages.at(-1)?.content ?? "") });
        if (choice === "none") {
          return { content: "changed a.txt; tests not run yet", reasoning: "", toolCalls: [], usage: undefined, finishReason: "stop" };
        }
        return {
          content: "",
          reasoning: "",
          toolCalls: [{ id: `call_${seen.length}`, name: "bash", arguments: '{"command":"true"}' }],
          usage: undefined,
          finishReason: "tool_calls",
        };
      },
    } as unknown as OpenAiCompatibleProvider;

    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });

    const result = await runAgent({
      provider,
      tools: TOOLS,
      systemPrompt: "test",
      task: "loop",
      cwd: dir.path,
      title: "test",
      maxTurns: 5,
      contextTokens: 128_000,
      signal: new AbortController().signal,
      session,
      kap,
    });

    assert.equal(result.limitReached, true);
    assert.equal(result.turns, 5);
    assert.equal(result.answer, "changed a.txt; tests not run yet");
    // Turn 5 is preceded by the reminder; the sixth request is the tool-less wrap-up.
    assert.match(seen[4]?.last ?? "", /1 of 5 turns left/);
    assert.equal(seen.length, 6);
    assert.equal(seen[5]?.choice, "none");
    assert.match(seen[5]?.last ?? "", /tools are now off/);
  } finally {
    dir.cleanup();
  }
});

test("a failed wrap-up still ends the run with a note, not an error", async () => {
  const dir = tempDir();
  try {
    const provider = {
      model: "fake-model",
      async complete(_m: unknown, _t: unknown, _d: unknown, _s: unknown, choice = "auto") {
        if (choice === "none") throw new Error("provider down");
        return {
          content: "",
          reasoning: "",
          toolCalls: [{ id: "call_x", name: "bash", arguments: '{"command":"true"}' }],
          usage: undefined,
          finishReason: "tool_calls",
        };
      },
    } as unknown as OpenAiCompatibleProvider;

    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });
    const result = await runAgent({
      provider,
      tools: TOOLS,
      systemPrompt: "test",
      task: "loop",
      cwd: dir.path,
      title: "test",
      maxTurns: 2,
      contextTokens: 128_000,
      signal: new AbortController().signal,
      session,
      kap,
    });
    assert.equal(result.limitReached, true);
    assert.match(result.answer, /turn limit of 2 reached; the model wrote no report/);
  } finally {
    dir.cleanup();
  }
});

test("an already aborted signal fails fast", async () => {
  const dir = tempDir();
  try {
    const provider = {
      model: "fake-model",
      async complete() {
        throw new Error("should not be called");
      },
    } as unknown as OpenAiCompatibleProvider;

    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        runAgent({
          provider,
          tools: TOOLS,
          systemPrompt: "test",
          task: "never",
          cwd: dir.path,
          title: "test",
          maxTurns: 3,
          contextTokens: 128_000,
          signal: controller.signal,
          session,
          kap,
        }),
      /timed out/,
    );
  } finally {
    dir.cleanup();
  }
});

test("fails when the model hits its output limit", async () => {
  const dir = tempDir();
  try {
    const provider = {
      model: "fake-model",
      async complete() {
        return {
          content: "half an answer",
          reasoning: "",
          toolCalls: [],
          usage: undefined,
          finishReason: "length",
        };
      },
    } as unknown as OpenAiCompatibleProvider;

    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });

    await assert.rejects(
      () =>
        runAgent({
          provider,
          tools: TOOLS,
          systemPrompt: "test",
          task: "say hi",
          cwd: dir.path,
          title: "test",
          maxTurns: 3,
          contextTokens: 128_000,
          signal: new AbortController().signal,
          session,
          kap,
        }),
      /output limit/,
    );
  } finally {
    dir.cleanup();
  }
});

test("compacts the context before the window fills", async () => {
  let summaryCalls = 0;
  let issued = 0;
  const provider = {
    model: "fake-model",
    async complete(messages: Array<{ role: string; content: unknown }>) {
      if (String(messages[0]?.content ?? "").includes("You compress")) {
        summaryCalls += 1;
        return {
          content: "earlier steps summarized",
          reasoning: "",
          toolCalls: [],
          usage: undefined,
          finishReason: "stop",
        };
      }
      if (issued < 4) {
        issued += 1;
        return {
          content: "",
          reasoning: "",
          toolCalls: [{ id: `call_${issued}`, name: "bash", arguments: '{"command":"seq 1 4000"}' }],
          usage: undefined,
          finishReason: "tool_calls",
        };
      }
      return { content: "done", reasoning: "", toolCalls: [], usage: undefined, finishReason: "stop" };
    },
  } as unknown as OpenAiCompatibleProvider;

  const dir = tempDir();
  try {
    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });

    const result = await runAgent({
      provider,
      tools: TOOLS,
      systemPrompt: "test",
      task: "make a lot of output",
      cwd: dir.path,
      title: "test",
      maxTurns: 10,
      contextTokens: 500,
      signal: new AbortController().signal,
      session,
      kap,
    });

    assert.equal(result.answer, "done");
    assert.ok(result.compactions >= 1, "the context was compacted");
    assert.ok(summaryCalls >= 0);
  } finally {
    dir.cleanup();
  }
});

test("stops when the model keeps repeating the same call", async () => {
  const provider = {
    model: "fake-model",
    async complete() {
      return {
        content: "",
        reasoning: "",
        toolCalls: [{ id: "same", name: "bash", arguments: '{"command":"true"}' }],
        usage: undefined,
        finishReason: "tool_calls",
      };
    },
  } as unknown as OpenAiCompatibleProvider;

  const dir = tempDir();
  try {
    const session = new SessionLog(join(dir.path, "session"), newRunId());
    const kap = KapAdapter.detect({ cwd: dir.path, mode: "off", runId: "run-1" });

    await assert.rejects(
      () =>
        runAgent({
          provider,
          tools: TOOLS,
          systemPrompt: "test",
          task: "loop",
          cwd: dir.path,
          title: "test",
          maxTurns: 20,
          contextTokens: 128_000,
          signal: new AbortController().signal,
          session,
          kap,
        }),
      /repeated the same bash call/,
    );
  } finally {
    dir.cleanup();
  }
});
