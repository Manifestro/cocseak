import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { captureBaseline, collectChanges, commitAll, MAX_COMMIT_FILE_BYTES, readHead } from "../src/git.js";
import { tempDir } from "./helpers.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
    cwd,
    stdio: "ignore",
  });
}

test("reads additions, deletions, and untracked files from git", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\nthree\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");

    writeFileSync(join(dir.path, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(dir.path, "b.txt"), "x\ny\n");

    const changes = collectChanges(dir.path);
    const byPath = new Map(changes.files.map((file) => [file.path, file]));

    assert.equal(byPath.get("a.txt")?.status, "modified");
    assert.equal(byPath.get("a.txt")?.added, 2);
    assert.equal(byPath.get("a.txt")?.removed, 1);
    assert.equal(byPath.get("b.txt")?.status, "added");
    assert.equal(byPath.get("b.txt")?.added, 2);
    assert.match(changes.diff_stat, /2 file\(s\) changed/);
    assert.match(changes.diff_stat, /4 insertions\(\+\)/);
    assert.match(changes.diff_stat, /1 deletions\(-\)/);
  } finally {
    dir.cleanup();
  }
});

test("falls back to the tool trace outside a git repository", () => {
  const dir = tempDir();
  try {
    const changes = collectChanges(dir.path, [{ path: "src/a.ts", action: "write" }]);
    assert.deepEqual(changes.files, [{ path: "src/a.ts", status: "added", added: 0, removed: 0 }]);
  } finally {
    dir.cleanup();
  }
});

test("reports a clean tree", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");

    const changes = collectChanges(dir.path);
    assert.deepEqual(changes.files, []);
    assert.equal(changes.diff_stat, "no changes detected");
  } finally {
    dir.cleanup();
  }
});

test("ignores files that were already dirty when the run started", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");

    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\n");
    const baseline = captureBaseline(dir.path);
    assert.ok(baseline);

    assert.deepEqual(collectChanges(dir.path, [], baseline).files, []);

    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\nthree\n");
    const after = collectChanges(dir.path, [], baseline).files;
    assert.equal(after.length, 1);
    assert.equal(after[0]?.path, "a.txt");
  } finally {
    dir.cleanup();
  }
});

test("commits the worktree only when something changed", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");

    assert.deepEqual(commitAll(dir.path, "nothing").committed, false);

    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\n");
    const result = commitAll(dir.path, "cocseak: test");
    assert.equal(result.committed, true);
    assert.ok(result.hash);

    const log = execFileSync("git", ["log", "--oneline"], { cwd: dir.path, encoding: "utf8" });
    assert.match(log, /cocseak: test/);
    assert.equal(collectChanges(dir.path).files.length, 0);
  } finally {
    dir.cleanup();
  }
});

test("commits even when git has no identity configured", () => {
  const dir = tempDir();
  const home = tempDir();
  const previousHome = process.env.HOME;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  try {
    process.env.HOME = home.path;
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");

    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\n");
    const result = commitAll(dir.path, "cocseak: fallback identity");
    assert.equal(result.committed, true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    dir.cleanup();
    home.cleanup();
  }
});

test("reports work the agent committed itself, against the run's base", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");
    const base = readHead(dir.path);
    assert.ok(base);

    writeFileSync(join(dir.path, "b.txt"), "x\ny\n");
    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "agent commit");

    const changes = collectChanges(dir.path, [], null, base);
    const byPath = new Map(changes.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("b.txt")?.status, "added");
    assert.equal(byPath.get("b.txt")?.added, 2);
    assert.equal(byPath.get("a.txt")?.status, "modified");
    assert.equal(byPath.get("a.txt")?.added, 1);
  } finally {
    dir.cleanup();
  }
});

test("still includes untracked files when comparing to the base", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");
    const base = readHead(dir.path);

    writeFileSync(join(dir.path, "new.txt"), "hello\nworld\n");
    const changes = collectChanges(dir.path, [], null, base);
    assert.equal(changes.files.find((file) => file.path === "new.txt")?.added, 2);
  } finally {
    dir.cleanup();
  }
});

test("leaves oversized files and files holding a credential out of the commit", () => {
  const dir = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");

    writeFileSync(join(dir.path, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir.path, "feats [v1].npy"), Buffer.alloc(MAX_COMMIT_FILE_BYTES + 1));
    writeFileSync(join(dir.path, "pod.env.sh"), "export RUNPOD_API_KEY=Zq81mXk20Lp3nV7cQ0w9\n");

    const result = commitAll(dir.path, "cocseak: filtered");
    assert.equal(result.committed, true);
    assert.deepEqual(
      result.leftOut.map((file) => [file.path, file.reason]).sort(),
      [
        ["feats [v1].npy", "too large"],
        ["pod.env.sh", "holds a credential"],
      ],
    );

    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: dir.path,
      encoding: "utf8",
    });
    assert.equal(files.trim(), "a.txt");
    assert.ok(existsSync(join(dir.path, "pod.env.sh")), "left-out files stay in the worktree");
  } finally {
    dir.cleanup();
  }
});

test("never commits a link that points out of the worktree", () => {
  const dir = tempDir();
  const shared = tempDir();
  try {
    git(dir.path, "init", "-q");
    writeFileSync(join(dir.path, "a.txt"), "one\n");
    git(dir.path, "add", ".");
    git(dir.path, "commit", "-qm", "init");
    writeFileSync(join(shared.path, "train.jsonl"), "{}\n");
    symlinkSync(shared.path, join(dir.path, "data"));
    writeFileSync(join(dir.path, "b.txt"), "two\n");

    const result = commitAll(dir.path, "cocseak: with a link");
    assert.deepEqual(result.leftOut, [{ path: "data", reason: "links outside the worktree" }]);
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: dir.path,
      encoding: "utf8",
    });
    assert.deepEqual(files.trim().split("\n"), ["a.txt", "b.txt"]);
  } finally {
    dir.cleanup();
    shared.cleanup();
  }
});
