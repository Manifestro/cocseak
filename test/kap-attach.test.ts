import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError } from "../src/errors.js";
import { attachKap } from "../src/kap-attach.js";
import { tempDir } from "./helpers.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "ignore",
  });
}

function initRepo(): { path: string; cleanup: () => void } {
  const dir = tempDir();
  git(dir.path, "init", "-q");
  writeFileSync(join(dir.path, ".gitignore"), ".kap/\n");
  writeFileSync(join(dir.path, "README.md"), "# repo\n");
  git(dir.path, "add", ".");
  git(dir.path, "commit", "-qm", "init");
  mkdirSync(join(dir.path, ".kap"));
  return dir;
}

function fakeKap(directory: string): { bin: string; log: string } {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "kap.log");
  writeFileSync(
    join(bin, "kap"),
    `#!/bin/sh
printf 'ARGS %s\\n' "$*" >> "${log}"
if [ "$1" = "attempt" ] && [ "$2" = "start" ]; then
  WT="$PWD/.kap/worktrees/attempt-test-1"
  mkdir -p "$WT"
  printf '  branch:   kap/attempt-test-1\\n  worktree: %s\\n' "$WT"
  exit 0
fi
if [ "$1" = "hook" ] && [ "$2" = "session-start" ]; then
  printf '%s\\n' '{"hookSpecificOutput":{"additionalContext":"prior work"}}'
fi
exit 0
`,
  );
  chmodSync(join(bin, "kap"), 0o755);
  return { bin, log };
}

function withPath<T>(bin: string, body: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    return body();
  } finally {
    process.env.PATH = previous;
  }
}

test("starts an attempt in a clean KAP repository and moves the run there", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    const { bin, log } = fakeKap(tools.path);
    withPath(bin, () => {
      const attached = attachKap({
        cwd: dir.path,
        mode: "auto",
        runId: "run-1",
        task: "fix the parser",
        title: "Fix Parser",
        debug: () => {},
      });

      assert.equal(attached.created?.attempt, "attempt-test-1");
      assert.equal(attached.created?.branch, "kap/attempt-test-1");
      assert.equal(attached.workspace, join(realpathSync(dir.path), ".kap", "worktrees", "attempt-test-1"));
      assert.equal(attached.adapter.state.active, true);
      assert.equal(attached.adapter.state.attempt, "attempt-test-1");

      assert.match(readFileSync(log, "utf8"), /ARGS attempt start fix-parser --task fix the parser/);
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});

test("does not start an attempt over uncommitted work", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    const { bin } = fakeKap(tools.path);
    writeFileSync(join(dir.path, "README.md"), "# changed\n");

    withPath(bin, () => {
      const attached = attachKap({
        cwd: dir.path,
        mode: "auto",
        runId: "run-1",
        task: "x",
        title: "x",
        debug: () => {},
      });
      assert.equal(attached.created, null);
      assert.equal(attached.adapter.state.active, false);
      assert.match(attached.note ?? "", /uncommitted changes/);

      assert.throws(
        () =>
          attachKap({
            cwd: dir.path,
            mode: "on",
            runId: "run-1",
            task: "x",
            title: "x",
            debug: () => {},
          }),
        ConfigError,
      );
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});

test("stays out of the way without a KAP repository", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    rmSync(join(dir.path, ".kap"), { recursive: true, force: true });
    const { bin } = fakeKap(tools.path);

    withPath(bin, () => {
      const attached = attachKap({
        cwd: dir.path,
        mode: "auto",
        runId: "run-1",
        task: "x",
        title: "x",
        debug: () => {},
      });
      assert.equal(attached.created, null);
      assert.equal(attached.adapter.state.active, false);
      assert.match(attached.adapter.state.reason, /no \.kap/);
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});
