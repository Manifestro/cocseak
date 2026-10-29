import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdsCredential } from "./secrets.js";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
}

export interface ChangeSet {
  files: FileChange[];
  diff_stat: string;
}

/** Dirty paths and their contents when the run started. */
export type Baseline = Map<string, string | null>;

/**
 * Snapshot the dirty files before the agent touches anything.
 *
 * A nested run shares its worktree with the caller, which may already have uncommitted changes.
 * Comparing against this baseline keeps the report about what this run changed, not what happened
 * to be lying around.
 */
export function captureBaseline(cwd: string): Baseline | null {
  if (!isGitWorktree(cwd)) return null;
  const status = git(cwd, ["status", "--porcelain=v1", "-z"]);
  if (status === null) return null;

  const baseline: Baseline = new Map();
  const records = status.split("\u0000").filter((record) => record !== "");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;
    baseline.set(path, hashFile(cwd, path));
  }
  return baseline;
}

const MAX_FILES = 200;

/**
 * What the run actually changed in the workspace, as git sees it.
 *
 * The harness reports this rather than asking the caller to diff afterwards: a nested agent has
 * one workspace and no reliable base to compare against, while cocseak was there when the files
 * changed. Outside a git repository the tool trace is used instead.
 */
export function collectChanges(
  cwd: string,
  fallback: readonly { path: string; action: "write" | "edit" }[] = [],
  baseline: Baseline | null = null,
  baseCommit: string | null = null,
): ChangeSet {
  if (!isGitWorktree(cwd)) return fallbackChangeSet(fallback);

  const files = baseCommit !== null ? changesSince(cwd, baseCommit) : changesInTree(cwd);
  if (files === null) return fallbackChangeSet(fallback);

  const relevant = (baseline === null ? files : files.filter((file) => wasChangedSince(cwd, baseline, file.path)))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);

  return { files: relevant, diff_stat: describe(relevant) };
}

/**
 * The working tree against HEAD. This is what a run leaves behind when it does not commit, but it
 * misses anything the agent committed itself.
 */
function changesInTree(cwd: string): FileChange[] | null {
  const status = git(cwd, ["status", "--porcelain=v1", "-z"]);
  if (status === null) return null;

  const counts = parseNumstat(git(cwd, ["diff", "--numstat", "HEAD"]) ?? "");
  const files: FileChange[] = [];
  const records = status.split("\u0000").filter((record) => record !== "");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;

    if (code === "??") {
      files.push({ path, status: "added", added: countLines(cwd, path), removed: 0 });
      continue;
    }
    const counted = counts.get(path) ?? { added: 0, removed: 0 };
    files.push({
      path,
      status: code.includes("D")
        ? "deleted"
        : code.includes("A")
          ? "added"
          : code.includes("R")
            ? "renamed"
            : "modified",
      added: counted.added,
      removed: counted.removed,
    });
  }
  return files;
}

/**
 * The run against the commit it started from. This is the honest picture: it includes work the
 * agent committed, work left uncommitted, and files added or deleted either way.
 */
function changesSince(cwd: string, baseCommit: string): FileChange[] | null {
  const status = git(cwd, ["diff", "--name-status", "-z", baseCommit]);
  if (status === null) return null;

  const counts = parseNumstat(git(cwd, ["diff", "--numstat", baseCommit]) ?? "");
  const files: FileChange[] = [];
  const tokens = status.split("\u0000").filter((token) => token !== "");

  for (let index = 0; index < tokens.length; ) {
    const code = (tokens[index++] as string).charAt(0);
    if (code === "R" || code === "C") {
      index += 1; // the previous path
      const path = tokens[index++] ?? "";
      const counted = counts.get(path) ?? { added: 0, removed: 0 };
      files.push({ path, status: "renamed", added: counted.added, removed: counted.removed });
      continue;
    }
    const path = tokens[index++] ?? "";
    const counted = counts.get(path) ?? { added: 0, removed: 0 };
    files.push({
      path,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      added: counted.added,
      removed: counted.removed,
    });
  }

  const known = new Set(files.map((file) => file.path));
  for (const path of untrackedFiles(cwd)) {
    if (known.has(path)) continue;
    files.push({ path, status: "added", added: countLines(cwd, path), removed: 0 });
  }
  return files;
}

function untrackedFiles(cwd: string): string[] {
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return [];
  return status
    .split("\u0000")
    .filter((record) => record.startsWith("?? "))
    .map((record) => record.slice(3));
}

function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [addedRaw, removedRaw, ...rest] = line.split("\t");
    const path = rest.join("\t").trim();
    if (!path) continue;
    counts.set(path, {
      added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0,
      removed: removedRaw === "-" ? 0 : Number.parseInt(removedRaw ?? "0", 10) || 0,
    });
  }
  return counts;
}

function wasChangedSince(cwd: string, baseline: Baseline, path: string): boolean {
  if (!baseline.has(path)) return true;
  return baseline.get(path) !== hashFile(cwd, path);
}

function hashFile(cwd: string, path: string): string | null {
  try {
    return createHash("sha1").update(readFileSync(`${cwd}/${path}`)).digest("hex");
  } catch {
    return null;
  }
}

function fallbackChangeSet(fallback: readonly { path: string; action: "write" | "edit" }[]): ChangeSet {
  const files = fallback.map<FileChange>((change) => ({
    path: change.path,
    status: change.action === "write" ? "added" : "modified",
    added: 0,
    removed: 0,
  }));
  return { files, diff_stat: files.length === 0 ? "no changes detected" : `${files.length} file(s) changed` };
}

function describe(files: readonly FileChange[]): string {
  if (files.length === 0) return "no changes detected";
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return `${files.length} file(s) changed, ${added} insertions(+), ${removed} deletions(-)`;
}

/** True when the tree has no staged, unstaged, or untracked files. */
export function isCleanWorktree(cwd: string): boolean {
  const status = git(cwd, ["status", "--porcelain"]);
  return status !== null && status.trim() === "";
}

/** Tracked files with changes. Untracked files are not counted: a new worktree simply lacks them. */
export function hasTrackedChanges(cwd: string): boolean {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return status === null || status.trim() !== "";
}

/** How many untracked, unignored files the tree holds. */
export function countUntracked(cwd: string): number {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === null) return 0;
  return status.split("\n").filter((line) => line.startsWith("??")).length;
}

/** Above this size a file is not committed: datasets, checkpoints, and embeddings stay out of git. */
export const MAX_COMMIT_FILE_BYTES = 10 * 1024 * 1024;

export interface LeftOutFile {
  path: string;
  reason: "too large" | "holds a credential" | "links outside the worktree";
}

export interface CommitResult {
  committed: boolean;
  hash: string | null;
  path: string;
  /** Changed files that were deliberately not committed; they stay in the worktree. */
  leftOut: LeftOutFile[];
}

/**
 * Commit what the run changed, except files that must not enter git.
 *
 * A commit is permanent and travels with every push and merge. A file over the size limit or one
 * holding something shaped like a credential is left uncommitted in the worktree and reported, so
 * a person decides what happens to it.
 */
export function commitAll(cwd: string, message: string): CommitResult {
  if (!isGitWorktree(cwd)) return { committed: false, hash: null, path: cwd, leftOut: [] };

  const leftOut = filesToLeaveOut(cwd);
  const list = join(tmpdir(), `cocseak-pathspec-${process.pid}-${Date.now()}`);
  const pathspecs = [".", ...leftOut.map((file) => `:(exclude,literal)${file.path}`)];
  writeFileSync(list, `${pathspecs.join("\0")}\0`);
  try {
    git(cwd, ["add", "-A", `--pathspec-from-file=${list}`, "--pathspec-file-nul"]);
  } finally {
    try {
      unlinkSync(list);
    } catch {
      // already gone
    }
  }
  // `git diff --quiet` exits 1 when something is staged, and `git` turns that into null.
  const dirty = git(cwd, ["diff", "--cached", "--quiet"]) === null;
  if (!dirty) return { committed: false, hash: null, path: cwd, leftOut };

  const committed =
    git(cwd, ["commit", "-q", "-m", message]) ??
    git(cwd, ["-c", "user.name=cocseak", "-c", "user.email=cocseak@localhost", "commit", "-q", "-m", message]);
  if (committed === null) return { committed: false, hash: null, path: cwd, leftOut };

  const hash = git(cwd, ["rev-parse", "--short", "HEAD"])?.trim() ?? null;
  return { committed: true, hash, path: cwd, leftOut };
}

/** Changed or new files that are too large for git or hold a credential. */
function filesToLeaveOut(cwd: string): LeftOutFile[] {
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return [];

  const leftOut: LeftOutFile[] = [];
  const entries = status.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename carries its old path as the next entry.
    if (code.includes("R") || code.includes("C")) index += 1;
    if (code.includes("D")) continue;

    // A link KAP made into the main checkout (data, checkpoints) is shared state, not a change.
    try {
      if (lstatSync(join(cwd, path)).isSymbolicLink()) {
        const target = realpathSync(join(cwd, path));
        const root = realpathSync(cwd);
        if (target !== root && !target.startsWith(`${root}/`)) {
          leftOut.push({ path, reason: "links outside the worktree" });
          continue;
        }
      }
    } catch {
      // a dangling link: let git decide
    }

    let size: number;
    try {
      const stats = statSync(join(cwd, path));
      if (!stats.isFile()) continue;
      size = stats.size;
    } catch {
      continue;
    }

    if (size > MAX_COMMIT_FILE_BYTES) {
      leftOut.push({ path, reason: "too large" });
      continue;
    }
    try {
      const text = readFileSync(join(cwd, path), "utf8");
      // Binary files are judged by size alone, as KAP's redaction does: random bytes read as
      // text look like keys everywhere.
      if (!text.includes("\0") && holdsCredential(text)) {
        leftOut.push({ path, reason: "holds a credential" });
      }
    } catch {
      // unreadable: let git decide
    }
  }
  return leftOut;
}

/** The commit the run starts from, or null outside a repository. */
export function readHead(cwd: string): string | null {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
  return head ? head : null;
}

/** The top of the git repository holding `cwd`, or null outside one. */
export function gitTopLevel(cwd: string): string | null {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  return top ? top : null;
}

export function isGitWorktree(cwd: string): boolean {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result?.trim() === "true";
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function countLines(cwd: string, path: string): number {
  try {
    const bytes = readFileSync(`${cwd}/${path}`);
    if (bytes.includes(0)) return 0;
    const text = bytes.toString("utf8");
    if (text === "") return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}
