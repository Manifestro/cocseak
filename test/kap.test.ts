import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { findAttempt, findKapRoot, KapAdapter } from "../src/kap.js";
import { tempDir } from "./helpers.js";

test("findAttempt reads the id out of a worktree path", () => {
  assert.equal(findAttempt("/repo/.kap/worktrees/attempt-42"), "attempt-42");
  assert.equal(findAttempt("/repo/.kap/worktrees/attempt-42/src/deep"), "attempt-42");
  assert.equal(findAttempt("/repo/src"), null);
  assert.equal(findAttempt("/repo/.kap/worktrees"), null);
});

test("findKapRoot walks up to the repository", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir.path, ".kap"));
    mkdirSync(join(dir.path, "src", "deep"), { recursive: true });
    assert.equal(findKapRoot(join(dir.path, "src", "deep")), dir.path);
    assert.equal(findKapRoot("/"), null);
  } finally {
    dir.cleanup();
  }
});

test("records through kap hooks when inside an attempt", async () => {
  const dir = tempDir();
  const previousPath = process.env.PATH;
  const previousLog = process.env.FAKE_KAP_LOG;
  try {
    mkdirSync(join(dir.path, ".kap", "worktrees", "attempt-1"), { recursive: true });
    const bin = join(dir.path, "bin");
    mkdirSync(bin);
    const log = join(dir.path, "kap.log");
    writeFileSync(
      join(bin, "kap"),
      `#!/bin/sh
LOG="$FAKE_KAP_LOG"
{
  printf 'ARGS %s\\n' "$*"
  cat
  printf '\\n---END---\\n'
} >> "$LOG"
if [ "$1" = "hook" ] && [ "$2" = "session-start" ]; then
  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"earlier: attempt-1"}}'
elif [ "$1" = "decision" ]; then
  printf 'decision-abc123  something\\n'
fi
exit 0
`,
    );
    chmodSync(join(bin, "kap"), 0o755);

    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.FAKE_KAP_LOG = log;

    const worktree = join(dir.path, ".kap", "worktrees", "attempt-1");
    const adapter = KapAdapter.detect({ cwd: worktree, mode: "auto", runId: "run-1" });
    assert.equal(adapter.state.active, true);
    assert.equal(adapter.state.attempt, "attempt-1");

    const briefing = await adapter.sessionStart();
    assert.equal(briefing, "earlier: attempt-1");

    await adapter.postToolUse("call_1", {
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      toolResponse: { stdout: "hi\n", stderr: "" },
      failed: false,
    });
    await adapter.postToolUse("call_2", {
      toolName: "Write",
      toolInput: { file_path: join(worktree, "a.txt"), content: "x" },
      toolResponse: {},
      failed: false,
    });
    await adapter.stop();

    const decisionId = await adapter.decision("use hooks", "KAP records them", "wrap the CLI");
    assert.equal(decisionId, "decision-abc123");

    const text = readFileSync(log, "utf8");
    assert.match(text, /ARGS hook session-start/);
    assert.match(text, /ARGS hook post-tool-use/);
    assert.match(text, /ARGS hook stop/);
    assert.match(text, /ARGS decision add --summary use hooks --rationale KAP records them --alternatives wrap the CLI/);
    assert.match(text, /"tool_use_id":"call_1"/);
    assert.match(text, /"tool_name":"Bash"/);
    assert.match(text, /"agent_type":"cocseak"/);
    assert.match(text, /"file_path":".*a\.txt"/);
  } finally {
    process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FAKE_KAP_LOG;
    else process.env.FAKE_KAP_LOG = previousLog;
    dir.cleanup();
  }
});

test("stays inactive outside an attempt", () => {
  const dir = tempDir();
  const previousPath = process.env.PATH;
  try {
    mkdirSync(join(dir.path, ".kap"));
    const bin = join(dir.path, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "kap"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "kap"), 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;

    const adapter = KapAdapter.detect({ cwd: dir.path, mode: "auto", runId: "run-1" });
    assert.equal(adapter.state.active, false);
    assert.match(adapter.state.reason, /not inside a KAP attempt/);
  } finally {
    process.env.PATH = previousPath;
    dir.cleanup();
  }
});

test("--kap on fails loudly without an attempt", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => KapAdapter.detect({ cwd: dir.path, mode: "on", runId: "run-1" }),
      /--kap on/,
    );
  } finally {
    dir.cleanup();
  }
});
