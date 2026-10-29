import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { tempDir } from "./helpers.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks) {
    res.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

const bashCall = {
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"echo hi"}' },
          },
        ],
      },
    },
  ],
};

const decisionCall = {
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_2",
            type: "function",
            function: {
              name: "record_decision",
              arguments: JSON.stringify({
                summary: "keep it one-shot",
                rationale: "a router needs no session",
                alternatives: "interactive REPL",
              }),
            },
          },
        ],
      },
    },
  ],
};

const finalAnswer = { choices: [{ delta: { content: "done" } }] };
const usage = { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

test("end to end: one-shot run records tool calls through KAP hooks", { timeout: 60_000 }, async () => {
  const dir = tempDir();
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      if (requests === 1) sse(res, [bashCall, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, usage]);
      else if (requests === 2) sse(res, [decisionCall, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
      else sse(res, [finalAnswer, { choices: [{ delta: {}, finish_reason: "stop" }] }, usage]);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;

  try {
    const repo = join(dir.path, "repo");
    const worktree = join(repo, ".kap", "worktrees", "attempt-1");
    mkdirSync(worktree, { recursive: true });

    const bin = join(dir.path, "bin");
    mkdirSync(bin);
    const kapLog = join(dir.path, "kap.log");
    writeFileSync(
      join(bin, "kap"),
      `#!/bin/sh
{
  printf 'ARGS %s\\n' "$*"
  cat
  printf '\\n---END---\\n'
} >> "$FAKE_KAP_LOG"
if [ "$1" = "hook" ] && [ "$2" = "session-start" ]; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"earlier attempt used the parser"}}'
elif [ "$1" = "decision" ]; then
  printf 'decision-abc123  done\\n'
fi
exit 0
`,
    );
    chmodSync(join(bin, "kap"), 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      COCSEAK_HOME: join(dir.path, "home"),
      FAKE_KAP_LOG: kapLog,
    };

    const child = spawn(
      process.execPath,
      [
        tsxCli,
        join(projectRoot, "src/cli.ts"),
        "--os",
        "--title",
        "e2e",
        "--task",
        "say hi",
        "--json",
        "--report",
        join(dir.path, "report.md"),
      ],
      { cwd: worktree, env },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    const code: number | null = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.equal(requests, 3);

    const report = JSON.parse(stdout.trim()) as {
      report_version: number;
      status: string;
      ok: boolean;
      answer: string;
      turns: number;
      session: string;
      commands: Array<{ command: string; exit_code: number | null }>;
      decisions: Array<{ summary: string }>;
      changes: { files: unknown[] };
      kap: { active: boolean; attempt: string };
    };
    assert.equal(report.report_version, 1);
    assert.equal(report.status, "completed");
    assert.equal(report.ok, true);
    assert.equal(report.answer, "done");
    assert.equal(report.turns, 3);
    assert.equal(report.kap.active, true);
    assert.equal(report.kap.attempt, "attempt-1");
    assert.deepEqual(report.commands, [{ command: "echo hi", exit_code: 0, duration_ms: report.commands[0]?.duration_ms }]);
    assert.equal(report.decisions[0]?.summary, "keep it one-shot");
    assert.deepEqual(report.changes.files, []);

    assert.match(stderr, /kap: recording attempt attempt-1/);
    assert.match(stderr, /turn 1/);

    const log = readFileSync(kapLog, "utf8");
    assert.match(log, /ARGS hook session-start/);
    assert.match(log, /ARGS hook post-tool-use/);
    assert.match(log, /"tool_name":"Bash"/);
    assert.match(log, /"tool_use_id":"call_1"/);
    assert.match(log, /ARGS decision add --summary keep it one-shot/);
    assert.match(log, /ARGS hook stop/);

    const markdown = readFileSync(join(dir.path, "report.md"), "utf8");
    assert.match(markdown, /^# cocseak report: e2e$/m);
    assert.match(markdown, /\| `echo hi` \| 0 \|/);

    assert.ok(existsSync(report.session), "session log was written");
    const sessionText = readFileSync(report.session, "utf8");
    assert.match(sessionText, /"type":"run_start"/);
    assert.match(sessionText, /"type":"decision"/);
    assert.match(sessionText, /"type":"run_end"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    dir.cleanup();
  }
});
