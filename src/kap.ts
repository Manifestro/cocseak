import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { spawn } from "node:child_process";

import { ConfigError } from "./errors.js";

export type KapMode = "auto" | "on" | "off";

export interface KapState {
  active: boolean;
  root: string | null;
  attempt: string | null;
  binary: string | null;
  reason: string;
}

/** One tool call, translated into the shape KAP's hook parser understands. */
export interface HookEvent {
  /** Claude-compatible tool name: Bash, Read, Write, Edit, Glob, Grep. */
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: Record<string, unknown>;
  failed: boolean;
}

const HOOK_TIMEOUT_MS = 5_000;
const DECISION_TIMEOUT_MS = 10_000;

/**
 * KAP's adapter, the same way Claude Code's is built: hooks.
 *
 * KAP records a session by being called at four points — SessionStart, PostToolUse,
 * PostToolUseFailure, and Stop — with a JSON payload on stdin. Claude Code calls those hooks
 * itself; cocseak does the same for its own lifecycle. KAP decides where to write; it walks up
 * from the hook's cwd, so a hook fired outside an attempt is a silent no-op.
 */
export class KapAdapter {
  readonly state: KapState;
  private readonly cwd: string;
  private readonly runId: string;
  private readonly debug: (message: string) => void;
  private failures = 0;

  private constructor(cwd: string, runId: string, state: KapState, debug: (message: string) => void) {
    this.cwd = cwd;
    this.runId = runId;
    this.state = state;
    this.debug = debug;
  }

  static detect(options: {
    cwd: string;
    mode: KapMode;
    runId: string;
    debug?: (message: string) => void;
  }): KapAdapter {
    const debug = options.debug ?? (() => {});
    if (options.mode === "off") {
      return new KapAdapter(options.cwd, options.runId, {
        active: false,
        root: null,
        attempt: null,
        binary: null,
        reason: "disabled by --kap off",
      }, debug);
    }

    const root = findKapRoot(options.cwd);
    const attempt = findAttempt(options.cwd);
    const binary = findKapBinary();

    if (!root) {
      if (options.mode === "on") {
        throw new ConfigError("--kap on, but no .kap directory was found above --cwd.");
      }
      return new KapAdapter(options.cwd, options.runId, {
        active: false,
        root: null,
        attempt: null,
        binary,
        reason: "no .kap directory in this workspace",
      }, debug);
    }
    if (!binary) {
      if (options.mode === "on") {
        throw new ConfigError("--kap on, but the `kap` binary is not on PATH.");
      }
      return new KapAdapter(options.cwd, options.runId, {
        active: false,
        root,
        attempt,
        binary: null,
        reason: "`kap` is not on PATH",
      }, debug);
    }
    if (!attempt) {
      if (options.mode === "on") {
        throw new ConfigError(
          "--kap on, but --cwd is not inside .kap/worktrees/<attempt>. " +
            "Start an attempt with `kap attempt start` and run cocseak inside its worktree.",
        );
      }
      return new KapAdapter(options.cwd, options.runId, {
        active: false,
        root,
        attempt: null,
        binary,
        reason: "cwd is not inside a KAP attempt worktree",
      }, debug);
    }

    return new KapAdapter(options.cwd, options.runId, {
      active: true,
      root,
      attempt,
      binary,
      reason: "hooks are recorded for this attempt",
    }, debug);
  }

  /** Ask KAP for the attempt briefing. Returns null when there is nothing to inject. */
  async sessionStart(): Promise<string | null> {
    if (!this.state.active) return null;
    const result = await this.hook("session-start", {});
    if (result.stdout.trim() === "") return null;

    try {
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      const context = parsed.hookSpecificOutput?.additionalContext;
      return typeof context === "string" && context.trim() !== "" ? context : null;
    } catch {
      this.debug("kap: session-start returned non-JSON output");
      return null;
    }
  }

  /** Record one tool call as a KAP tool event (or file_change + evidence for edits). */
  async postToolUse(callId: string, event: HookEvent): Promise<void> {
    if (!this.state.active) return;
    const name = event.failed ? "post-tool-use-failure" : "post-tool-use";
    const payload = {
      session_id: this.runId,
      cwd: this.cwd,
      hook_event_name: event.failed ? "PostToolUseFailure" : "PostToolUse",
      tool_name: event.toolName,
      tool_input: event.toolInput,
      tool_response: event.toolResponse,
      tool_use_id: callId,
      agent_type: "cocseak",
    };
    const result = await this.hook(name, payload);
    if (result.code !== 0) this.debug(`kap: ${name} exited ${result.code}`);
  }

  /** Finish the run and let KAP snapshot the worktree as evidence. */
  async stop(): Promise<void> {
    if (!this.state.active) return;
    const result = await this.hook("stop", {
      session_id: this.runId,
      cwd: this.cwd,
      hook_event_name: "Stop",
    });
    if (result.code !== 0) this.debug(`kap: stop exited ${result.code}`);
  }

  /**
   * Decisions have no hook in KAP: Claude Code records them by calling `kap decision add`, and
   * cocseak does the same. Returns the decision id, or null when KAP is not recording.
   */
  async decision(summary: string, rationale?: string, alternatives?: string): Promise<string | null> {
    if (!this.state.active) return null;

    const args = ["decision", "add", "--summary", summary];
    if (rationale) args.push("--rationale", rationale);
    if (alternatives) args.push("--alternatives", alternatives);

    const result = await run(this.state.binary as string, args, undefined, this.cwd, DECISION_TIMEOUT_MS);
    if (result.code !== 0) {
      this.debug(`kap: decision add exited ${result.code}: ${result.stderr.trim()}`);
      return null;
    }
    const first = result.stdout.trim().split(/\r?\n/)[0] ?? "";
    return first.split(/\s+/)[0] ?? null;
  }

  /** A short summary for the JSON result, without leaking paths that do not matter. */
  describe(): Record<string, unknown> {
    return {
      active: this.state.active,
      attempt: this.state.attempt,
      reason: this.state.reason,
      failures: this.failures,
    };
  }

  private async hook(
    name: string,
    payload: Record<string, unknown>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await run(
      this.state.binary as string,
      ["hook", name],
      JSON.stringify(payload),
      this.cwd,
      HOOK_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      this.failures += 1;
      this.debug(`kap: hook ${name} exited ${result.code}: ${result.stderr.trim()}`);
    }
    return result;
  }
}

export function findKapRoot(start: string): string | null {
  let current = start;
  while (true) {
    try {
      if (statSync(join(current, ".kap")).isDirectory()) return current;
    } catch {
      // keep walking
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The attempt id encoded in `.kap/worktrees/<id>`, if the cwd is inside one. */
export function findAttempt(cwd: string): string | null {
  const parts = cwd.split(sep);
  for (let index = parts.length - 3; index >= 0; index -= 1) {
    if (parts[index] === ".kap" && parts[index + 1] === "worktrees" && parts[index + 2]) {
      return parts[index + 2] as string;
    }
  }
  return null;
}

export function findKapBinary(): string | null {
  const path = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, `kap${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  binary: string,
  args: readonly string[],
  stdin: string | undefined,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));

    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
