import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
): ChangeSet {
  if (!isGitWorktree(cwd)) return fallbackChangeSet(fallback);

  const status = git(cwd, ["status", "--porcelain=v1", "-z"]);
  if (status === null) return fallbackChangeSet(fallback);

  const numstat = git(cwd, ["diff", "--numstat", "HEAD"]);
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of (numstat ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const [addedRaw, removedRaw, ...rest] = line.split("\t");
    const path = rest.join("\t").trim();
    if (!path) continue;
    counts.set(path, {
      added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0,
      removed: removedRaw === "-" ? 0 : Number.parseInt(removedRaw ?? "0", 10) || 0,
    });
  }

  const files: FileChange[] = [];
  const records = status.split("\u0000").filter((record) => record !== "");
  for (let index = 0; index < records.length && files.length < MAX_FILES; index += 1) {
    const record = records[index] as string;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes("R") || code.includes("C")) {
      index += 1; // the next NUL-separated record is the original path
    }

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

  files.sort((a, b) => a.path.localeCompare(b.path));

  const relevant = baseline === null ? files : files.filter((file) => wasChangedSince(cwd, baseline, file.path));
  return { files: relevant, diff_stat: describe(relevant) };
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

export interface CommitResult {
  committed: boolean;
  hash: string | null;
  path: string;
}

/** Commit everything currently in the worktree, if anything is untracked or modified. */
export function commitAll(cwd: string, message: string): CommitResult {
  if (!isGitWorktree(cwd)) return { committed: false, hash: null, path: cwd };

  git(cwd, ["add", "-A"]);
  // `git diff --quiet` exits 1 when something is staged, and `git` turns that into null.
  const dirty = git(cwd, ["diff", "--cached", "--quiet"]) === null;
  if (!dirty) return { committed: false, hash: null, path: cwd };

  if (git(cwd, ["commit", "-q", "-m", message]) === null) {
    return { committed: false, hash: null, path: cwd };
  }

  const hash = git(cwd, ["rev-parse", "--short", "HEAD"])?.trim() ?? null;
  return { committed: true, hash, path: cwd };
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
