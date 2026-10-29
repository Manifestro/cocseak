import { execFileSync } from "node:child_process";
import { ConfigError } from "./errors.js";
import { isCleanWorktree } from "./git.js";
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
}

/**
 * Connect to KAP without being asked.
 *
 * Claude Code is recorded because KAP installs hooks into its settings; cocseak has no install
 * step, so it attaches itself at startup. Inside an attempt worktree that means reporting through
 * the hooks. In a clean KAP repository it means starting an attempt first, so the run lands in
 * history with its own branch instead of quietly going unrecorded.
 *
 * A dirty tree is deliberately not turned into an attempt: `kap attempt start` branches from HEAD,
 * so the uncommitted work would not be in the worktree — the agent would not see it.
 */
export function attachKap(options: {
  cwd: string;
  mode: KapMode;
  runId: string;
  task: string;
  title: string;
  debug: (message: string) => void;
}): AttachedKap {
  const { cwd, mode, runId, debug } = options;

  if (mode === "off") {
    return {
      workspace: cwd,
      adapter: KapAdapter.inactive(cwd, runId, "disabled by --kap off", debug),
      created: null,
      note: null,
    };
  }

  const binary = findKapBinary();
  const root = findKapRoot(cwd);

  if (!binary || !root) {
    const reason = !root ? "no .kap directory in this workspace" : "`kap` is not on PATH";
    if (mode === "on") {
      throw new ConfigError(`--kap on, but ${reason}.`);
    }
    return { workspace: cwd, adapter: KapAdapter.inactive(cwd, runId, reason, debug), created: null, note: null };
  }

  if (findAttempt(cwd)) {
    return { workspace: cwd, adapter: KapAdapter.detect({ cwd, mode: "on", runId, debug }), created: null, note: null };
  }

  if (!isCleanWorktree(root)) {
    const note =
      "the repository has uncommitted changes, so no attempt was started " +
      "(its worktree would branch from HEAD and miss them). Commit or stash, or run " +
      "`kap attempt start` yourself and work in its worktree.";
    if (mode === "on") throw new ConfigError(note);
    debug(`kap: ${note}`);
    return { workspace: cwd, adapter: KapAdapter.inactive(cwd, runId, note, debug), created: null, note };
  }

  const created = startAttempt(binary, root, options.title, options.task);
  return {
    workspace: created.worktree,
    adapter: KapAdapter.detect({ cwd: created.worktree, mode: "on", runId, debug }),
    created,
    note: null,
  };
}

function startAttempt(binary: string, root: string, title: string, task: string): CreatedAttempt {
  const label = slug(title) || "cocseak";

  let output: string;
  try {
    output = execFileSync(binary, ["attempt", "start", label, "--task", task], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string };
    const detail = firstLine(failure.stderr || failure.stdout || failure.message);
    throw new ConfigError(`could not start a KAP attempt: ${detail}`);
  }

  const worktree = field(output, "worktree");
  const branch = field(output, "branch");
  if (!worktree) throw new ConfigError("kap attempt start did not report a worktree");

  return {
    attempt: findAttempt(worktree) ?? "",
    branch: branch ?? "",
    worktree,
  };
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
