import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
if [ "$1" = "init" ]; then
  mkdir -p "$PWD/.kap"
  printf '.kap/\n' >> "$PWD/.gitignore"
  exit 0
fi
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
        init: true,
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

test("refuses to run over uncommitted tracked work in a KAP repository", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    const { bin, log } = fakeKap(tools.path);
    writeFileSync(join(dir.path, "README.md"), "# changed\n");

    withPath(bin, () => {
      for (const mode of ["auto", "on"] as const) {
        assert.throws(
          () =>
            attachKap({
              cwd: dir.path,
              mode,
              runId: "run-1",
              task: "x",
              title: "x",
              init: true,
              debug: () => {},
            }),
          (error: unknown) => error instanceof ConfigError && /unrecorded/.test(error.message),
        );
      }
      assert.equal(existsSync(log), false, "no attempt was started");
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});

test("starts an attempt despite untracked files, and says they are not in it", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    const { bin } = fakeKap(tools.path);
    writeFileSync(join(dir.path, ".session.prev"), "local state\n");

    withPath(bin, () => {
      const attached = attachKap({
        cwd: dir.path,
        mode: "auto",
        runId: "run-1",
        task: "x",
        title: "x",
        init: true,
        debug: () => {},
      });
      assert.equal(attached.created?.attempt, "attempt-test-1");
      assert.ok(attached.notes.some((note) => /1 untracked file/.test(note)));
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
        init: false,
        debug: () => {},
      });
      assert.equal(attached.created, null);
      assert.equal(attached.adapter.state.active, false);
      assert.match(attached.note ?? "", /no \.kap/);
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});

test("bootstraps a bare directory: git, baseline commit, kap init, attempt", () => {
  const dir = tempDir();
  const tools = tempDir();
  try {
    writeFileSync(join(dir.path, "README.md"), "# new project\n");
    const { bin } = fakeKap(tools.path);

    withPath(bin, () => {
      const attached = attachKap({
        cwd: dir.path,
        mode: "auto",
        runId: "run-1",
        task: "translate the readme",
        title: "Translate",
        init: true,
        debug: () => {},
      });

      assert.equal(attached.created?.attempt, "attempt-test-1");
      assert.equal(attached.adapter.state.active, true);
      assert.ok(attached.notes.some((note) => /no git repository/.test(note)));
      assert.ok(attached.notes.some((note) => /initialised KAP/.test(note)));

      const log = execFileSync("git", ["log", "--oneline"], { cwd: dir.path, encoding: "utf8" });
      assert.match(log, /cocseak: baseline/);
      assert.match(log, /chore: ignore \.kap/);
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});

test("works from a subdirectory of an existing KAP repository", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    mkdirSync(join(dir.path, "packages", "app"), { recursive: true });
    const { bin } = fakeKap(tools.path);

    withPath(bin, () => {
      const attached = attachKap({
        cwd: join(dir.path, "packages", "app"),
        mode: "auto",
        runId: "run-1",
        task: "x",
        title: "Subdir",
        init: true,
        debug: () => {},
      });
      assert.equal(attached.created?.attempt, "attempt-test-1");
      assert.equal(attached.adapter.state.active, true);
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});

test("never initialises KAP or commits in a repository that already has history", () => {
  const dir = initRepo();
  const tools = tempDir();
  try {
    rmSync(join(dir.path, ".kap"), { recursive: true, force: true });
    writeFileSync(join(dir.path, ".gitignore"), "node_modules/\n");
    git(dir.path, "commit", "-qam", "no kap ignore");
    mkdirSync(join(dir.path, "packages", "app"), { recursive: true });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir.path, encoding: "utf8" });
    const { bin, log } = fakeKap(tools.path);

    withPath(bin, () => {
      const attached = attachKap({
        cwd: join(dir.path, "packages", "app"),
        mode: "auto",
        runId: "run-1",
        task: "x",
        title: "Subdir",
        init: true,
        debug: () => {},
      });
      assert.equal(attached.created, null);
      assert.equal(attached.adapter.state.active, false);
      assert.match(attached.note ?? "", /kap init/);
      assert.equal(existsSync(join(dir.path, ".kap")), false);
      assert.equal(existsSync(log), false, "kap was never called");

      const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir.path, encoding: "utf8" });
      assert.equal(after, before, "no commit was made");
      assert.equal(readFileSync(join(dir.path, ".gitignore"), "utf8"), "node_modules/\n");
    });
  } finally {
    dir.cleanup();
    tools.cleanup();
  }
});
