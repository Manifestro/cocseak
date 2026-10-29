import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findSession, loadSession, workspaceSessions } from "../src/session.js";
import { tempDir } from "./helpers.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(projectRoot, "src/cli.ts"), ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function writeLog(dir: string, events: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.v1.jsonl");
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return path;
}

const start = { type: "run_start", time: 1, run_id: "run-1", title: "t", task: "fix it", model: "m", cwd: "/w" };

test("a logged conversation is rebuilt exactly", () => {
  const dir = tempDir();
  try {
    const call = { id: "c1", name: "bash", arguments: '{"command":"ls"}' };
    const path = writeLog(join(dir.path, "run-1"), [
      start,
      { type: "message", time: 2, message: { role: "user", content: "fix it" } },
      { type: "message", time: 3, message: { role: "assistant", content: null, tool_calls: [call] } },
      { type: "message", time: 4, message: { role: "tool", tool_call_id: "c1", content: "a.txt" } },
      { type: "message", time: 5, message: { role: "assistant", content: "done" } },
    ]);
    const session = loadSession(path);
    assert.equal(session.exact, true);
    assert.equal(session.cwd, "/w");
    assert.deepEqual(
      session.messages.map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
    );
  } finally {
    dir.cleanup();
  }
});

test("compaction replaces the history, and an unanswered tool call is dropped", () => {
  const dir = tempDir();
  try {
    const call = { id: "c9", name: "bash", arguments: "{}" };
    const path = writeLog(join(dir.path, "run-1"), [
      start,
      { type: "message", time: 2, message: { role: "user", content: "old" } },
      { type: "history", time: 3, messages: [{ role: "user", content: "fix it" }, { role: "assistant", content: "summary" }] },
      { type: "message", time: 4, message: { role: "assistant", content: null, tool_calls: [call] } },
    ]);
    const session = loadSession(path);
    assert.deepEqual(
      session.messages.map((m) => m.content),
      ["fix it", "summary"],
    );
  } finally {
    dir.cleanup();
  }
});

test("a run from before transcripts resumes from a summary of its events", () => {
  const dir = tempDir();
  try {
    const path = writeLog(join(dir.path, "run-1"), [
      start,
      { type: "tool_call", time: 2, call_id: "c1", name: "bash", arguments: '{"command":"pytest"}' },
      { type: "tool_result", time: 3, call_id: "c1", name: "bash", output: "2 failed", exit_code: 1, is_error: true },
      { type: "run_end", time: 4, ok: false, turns: 3, usage: null, answer: "", error: "run timed out" },
    ]);
    const session = loadSession(path);
    assert.equal(session.exact, false);
    assert.equal(session.messages[0]?.content, "fix it");
    assert.match(String(session.messages[1]?.content), /pytest[\s\S]*2 failed[\s\S]*run timed out/);
  } finally {
    dir.cleanup();
  }
});

test("--resume continues the conversation in the earlier run's workspace", { timeout: 60_000 }, async () => {
  const dir = tempDir();
  const workspace = join(dir.path, "work");
  const elsewhere = join(dir.path, "elsewhere");
  mkdirSync(workspace);
  mkdirSync(elsewhere);
  const env: NodeJS.ProcessEnv = { ...process.env, COCSEAK_HOME: join(dir.path, "home") };
  for (const name of ["DEEPSEEK_API_KEY", "COCSEAK_API_KEY", "DEEPSEEK_BASE_URL", "COCSEAK_BASE_URL", "DEEPSEEK_MODEL", "COCSEAK_MODEL"]) {
    delete env[name];
  }

  const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
  const replies = ["the codeword is heron", "you told me: heron"];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      const text = replies[bodies.length - 1] ?? "?";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const common = ["--api-key", "k", "--base-url", `http://127.0.0.1:${address.port}/v1`, "--kap", "off", "--json"];

  try {
    const first = await run(["--os", "--title", "memo", "--task", "remember heron", ...common], env, workspace);
    assert.equal(first.code, 0, first.stderr);
    const firstReport = JSON.parse(first.stdout) as { session: string };

    // Resumed from another directory by path: it must still work in the first run's workspace.
    const second = await run(
      ["--os", "--resume", firstReport.session, "--task", "what was the codeword?", ...common],
      env,
      elsewhere,
    );
    assert.equal(second.code, 0, second.stderr);
    const report = JSON.parse(second.stdout) as { cwd: string; title: string; resumed_from: string; answer: string };
    assert.match(report.cwd, /work$/);
    assert.equal(report.title, "memo");
    assert.match(report.resumed_from, /^run-/);

    const sent = bodies[1]?.messages ?? [];
    assert.deepEqual(
      sent.map((m) => [m.role, m.content]).slice(1),
      [
        ["user", "remember heron"],
        ["assistant", "the codeword is heron"],
        ["user", "what was the codeword?"],
      ],
    );

    // `last` finds the newest run started from the workspace, and resumed runs chain.
    const third = await run(["--os", "--resume", "last", ...common], env, workspace);
    assert.equal(third.code, 0, third.stderr);
    const chained = bodies[2]?.messages.map((m) => m.content) ?? [];
    assert.ok(chained.includes("what was the codeword?"), "the third run sees the second run's turn");
    assert.match(String(chained.at(-1)), /Continue the work/);
    const previousHome = process.env.COCSEAK_HOME;
    process.env.COCSEAK_HOME = env.COCSEAK_HOME;
    try {
      // The child saw its cwd as a real path (/private/var on macOS), and runs are keyed by it.
      assert.match(findSession("last", realpathSync(workspace)), /session\.v1\.jsonl$/);
    } finally {
      if (previousHome === undefined) delete process.env.COCSEAK_HOME;
      else process.env.COCSEAK_HOME = previousHome;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    dir.cleanup();
  }
});

test("last means the latest start, even within one second", () => {
  const dir = tempDir();
  const previousHome = process.env.COCSEAK_HOME;
  process.env.COCSEAK_HOME = dir.path;
  try {
    const cwd = "/some/workspace";
    const folder = workspaceSessions(cwd);
    // Same second, and the later run has the alphabetically smaller suffix.
    writeLog(join(folder, "run-20261029221500-zzzzzz"), [{ ...start, run_id: "early", time: 1000 }]);
    writeLog(join(folder, "run-20261029221500-aaaaaa"), [{ ...start, run_id: "late", time: 2000 }]);
    assert.match(findSession("last", cwd), /run-20261029221500-aaaaaa/);
  } finally {
    if (previousHome === undefined) delete process.env.COCSEAK_HOME;
    else process.env.COCSEAK_HOME = previousHome;
    dir.cleanup();
  }
});
