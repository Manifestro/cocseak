import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ConfigError } from "./errors.js";
import { countUntracked, gitTopLevel, hasTrackedChanges } from "./git.js";
import { findAttempt, findKapBinary, findKapRoot, KapAdapter, type KapMode } from "./kap.js";

export interface CreatedAttempt {
  attempt: string;
  branch: string;
  worktree: string;
}

export interface AttachedKap {
  /** The directory the agent will work in; an attempt worktree when one was started. */
  workspace: string;
  adapter: KapAdapter;
  created: CreatedAttempt | null;
  /** Why recording is off, when it is off for a reason the user can act on. */
  note: string | null;
  /** Setup cocseak performed on the user's behalf, to be printed. */
  notes: string[];
}

/**
 * Connect to KAP without being asked.
 *
 * Claude Code is recorded because KAP installs hooks into its settings; cocseak has no install
 * step, so it attaches itself at startup. Inside an attempt worktree that means reporting through
 * the hooks. In a KAP repository without one it starts an attempt, so the run lands in history with
 * its own branch instead of quietly going unrecorded.
 *
 * A bare directory is not a place a coding agent should rewrite files: with `init` (the default),
 * cocseak makes it a git repository, commits the current state as a baseline, runs `kap init`, and
 * only then starts the attempt. `--no-init` turns that into an error instead. A repository that
 * already has history is someone's project: cocseak never runs `kap init` or commits there on its
 * own, it says how to opt in and runs unrecorded.
 *
 * Inside a KAP repository a run is recorded or it does not happen. Uncommitted tracked changes
 * would be missing from a new attempt's worktree, and working beside them in the main checkout
 * would write unrecorded changes into the very repository KAP is meant to account for.
 */
export function attachKap(options: {
  cwd: string;
  mode: KapMode;
  runId: string;
  task: string;
  title: string;
  init: boolean;
  debug: (message: string) => void;
}): AttachedKap {
  const { cwd, mode, runId, debug } = options;
  const notes: string[] = [];

  if (mode === "off") {
    return {
      workspace: cwd,
      adapter: KapAdapter.inactive(cwd, runId, "disabled by --kap off", debug),
      created: null,
      note: null,
      notes,
    };
  }

  const binary = findKapBinary();
  if (!binary) {
    if (mode === "on") throw new ConfigError("--kap on, but `kap` is not on PATH.");
    return {
      workspace: cwd,
      adapter: KapAdapter.inactive(cwd, runId, "`kap` is not on PATH", debug),
      created: null,
      note: null,
      notes,
    };
  }

  // KAP decides by real path; a symlinked workspace must not look like a fresh checkout.
  const probe = safeRealpath(cwd);
  let root = findKapRoot(probe);
  if (!root) {
    const existing = gitTopLevel(probe);
    if (existing && hasCommits(existing)) {
      const reason =
        `this repository has no .kap, so the run is not recorded; ` +
        `run \`kap init\` in ${existing} and commit .gitignore to record runs`;
      if (mode === "on") throw new ConfigError(`--kap on, but ${reason}.`);
      return {
        workspace: cwd,
        adapter: KapAdapter.inactive(cwd, runId, reason, debug),
        created: null,
        note: reason,
        notes,
      };
    }
    if (!options.init) {
      const reason = "no .kap repository here, and --no-init is set";
      if (mode === "on") throw new ConfigError(`--kap on, but ${reason}.`);
      return {
        workspace: cwd,
        adapter: KapAdapter.inactive(cwd, runId, reason, debug),
        created: null,
        note: reason,
        notes,
      };
    }
    root = bootstrap(binary, cwd, notes);
  } else if (!hasGit(root)) {
    // A .kap directory outside git cannot start an attempt; give it the repository it needs.
    if (!options.init) {
      const reason = "the .kap store is not inside a git repository, and --no-init is set";
      if (mode === "on") throw new ConfigError(`--kap on, but ${reason}.`);
      return {
        workspace: cwd,
        adapter: KapAdapter.inactive(cwd, runId, reason, debug),
        created: null,
        note: reason,
        notes,
      };
    }
    git(root, ["init", "-q"]);
    ensureKapIgnored(root);
    notes.push("the .kap store was not in a git repository — initialised one");
    commitBaseline(root, notes);
  } else if (!hasCommits(root)) {
    commitBaseline(root, notes);
  }

  if (findAttempt(probe)) {
    return {
      workspace: cwd,
      adapter: KapAdapter.detect({ cwd, mode: "on", runId, debug }),
      created: null,
      note: null,
      notes,
    };
  }

  if (hasTrackedChanges(root)) {
    throw new ConfigError(
      "the KAP repository has uncommitted changes to tracked files, so no attempt can start " +
        "(its worktree would branch from HEAD and miss them), and cocseak will not edit the main " +
        "checkout unrecorded. Commit or stash, run `kap attempt start` yourself and pass its " +
        "worktree as --cwd, or pass --kap off to run unrecorded on purpose.",
    );
  }

  const untracked = countUntracked(root);
  if (untracked > 0) {
    notes.push(
      `${untracked} untracked file(s) in the main checkout are not in the attempt's worktree`,
    );
  }

  const created = startAttempt(binary, root, options.title, options.task);
  return {
    workspace: created.worktree,
    adapter: KapAdapter.detect({ cwd: created.worktree, mode: "on", runId, debug }),
    created,
    note: null,
    notes,
  };
}

/** Make `cwd` a git repository that KAP can start an attempt from. */
function bootstrap(binary: string, cwd: string, notes: string[]): string {
  const top = gitTopLevel(cwd);
  const base = top ?? resolve(cwd);

  if (base === resolve(homedir()) || dirname(base) === base) {
    throw new ConfigError(
      "refusing to initialise a git repository in your home directory or at the filesystem root; run cocseak inside a project",
    );
  }

  if (!hasGit(base)) {
    git(base, ["init", "-q"]);
    notes.push("no git repository here — initialised one");
  }
  if (!hasCommits(base)) {
    commitBaseline(base, notes);
  }

  try {
    execFileSync(binary, ["init"], {
      cwd: base,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string };
    throw new ConfigError(
      `could not initialise KAP: ${firstLine(failure.stderr || failure.stdout || failure.message)}`,
    );
  }
  notes.push("initialised KAP (.kap/)");

  // `kap init` adds .kap/ to .gitignore; commit just that file so the tree is clean again.
  if (gitStatus(base, ".gitignore") !== "") {
    git(base, ["add", "--", ".gitignore"]);
    git(base, ["commit", "-q", "-m", "chore: ignore .kap", "--", ".gitignore"], true) ??
      git(
        base,
        ["-c", "user.name=cocseak", "-c", "user.email=cocseak@localhost", "commit", "-q", "-m", "chore: ignore .kap", "--", ".gitignore"],
        true,
      );
  }

  const root = findKapRoot(base);
  if (!root) throw new ConfigError("kap init finished, but no .kap directory appeared");
  return root;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function ensureKapIgnored(root: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", ".kap"], { cwd: root, stdio: "ignore" });
    return;
  } catch {
    // .kap is not ignored yet
  }
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) {
    appendFileSync(ignore, ".kap/\n");
  } else {
    appendFileSync(ignore, ".kap/\n");
  }
}

function commitBaseline(cwd: string, notes: string[]): void {
  git(cwd, ["add", "-A"]);
  const message = "cocseak: baseline";
  const committed =
    git(cwd, ["commit", "-q", "--allow-empty", "-m", message], true) ??
    git(
      cwd,
      ["-c", "user.name=cocseak", "-c", "user.email=cocseak@localhost", "commit", "-q", "--allow-empty", "-m", message],
      true,
    );
  if (committed !== null) notes.push("committed the current files as a baseline");
}

function startAttempt(binary: string, root: string, title: string, task: string): CreatedAttempt {
  const label = slug(title) || "cocseak";

  let output: string;
  try {
    output = execFileSync(binary, ["attempt", "start", label, "--task", task], {
      cwd: root,
      encoding: "utf8",
      // `.kap/worktree` may install an environment; that takes minutes, not seconds.
      timeout: ATTEMPT_START_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; stdout?: string; message: string };
    // Exit 3: the attempt exists but its setup failed. Working in it would mean working in a
    // broken environment, and the run could not tell its own failures from the setup's.
    const detail =
      failure.status === 3
        ? `the attempt was created but its .kap/worktree setup failed (see \`kap log\`)`
        : firstLine(failure.stderr || failure.stdout || failure.message);
    throw new ConfigError(`could not start a KAP attempt: ${detail}`);
  }

  const worktree = field(output, "worktree");
  const branch = field(output, "branch");
  if (!worktree) throw new ConfigError("kap attempt start did not report a worktree");

  return { attempt: findAttempt(worktree) ?? "", branch: branch ?? "", worktree };
}

const ATTEMPT_START_TIMEOUT_MS = 15 * 60_000;

function hasGit(cwd: string): boolean {
  return run(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

function hasCommits(cwd: string): boolean {
  return run(cwd, ["rev-parse", "--verify", "HEAD"]) !== null;
}

function gitStatus(cwd: string, path: string): string {
  return run(cwd, ["status", "--porcelain", "--", path])?.trim() ?? "";
}

function git(cwd: string, args: readonly string[], ignoreFailure = false): string | null {
  const output = run(cwd, args);
  if (output === null && !ignoreFailure) {
    throw new ConfigError(`git ${args.join(" ")} failed`);
  }
  return output;
}

function run(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function field(output: string, name: string): string | null {
  const match = output.match(new RegExp(`${name}:\\s*(\\S+)`));
  return match?.[1] ?? null;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? text.trim();
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
