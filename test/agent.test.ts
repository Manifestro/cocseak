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
      ["run_start", "tool_call", "tool_result", "run_end"],
    );
  } finally {
    dir.cleanup();
  }
});

test("stops at max turns", async () => {
  const dir = tempDir();
  try {
    const provider = {
      model: "fake-model",
      async complete() {
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

    await assert.rejects(
      () =>
        runAgent({
          provider,
          tools: TOOLS,
          systemPrompt: "test",
          task: "loop",
          cwd: dir.path,
          title: "test",
          maxTurns: 2,
          signal: new AbortController().signal,
          session,
          kap,
        }),
      /did not finish within 2 turns/,
    );
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
