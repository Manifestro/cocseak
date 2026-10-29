import { spawn } from "node:child_process";

import type { Tool, ToolContext, ToolResult } from "./types.js";
import { stringArg, truncateForModel } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const CAPTURE_LIMIT = 8 * 1024 * 1024;
const MODEL_LIMIT = 30_000;

interface Capture {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Capture> {
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

  if (signal.aborted) {
    return { stdout: "", stderr: "", code: null, timedOut: true };
  }

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    let settled = false;

    const collect = (sink: Buffer[], chunk: Buffer, length: number): number => {
      if (length >= CAPTURE_LIMIT) return length;
      sink.push(chunk);
      return length + chunk.length;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength = collect(stdout, chunk, stdoutLength);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength = collect(stderr, chunk, stderrLength);
    });

    const killGroup = (): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = (): void => {
      timedOut = true;
      killGroup();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        timedOut,
      });
    };

    child.on("error", (error) => {
      stderr.push(Buffer.from(String(error)));
      finish(127);
    });
    child.on("close", (code) => finish(code));
  });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace and return its stdout, stderr, and exit code. " +
    "Use it for builds, tests, git, and anything the other tools do not cover. " +
    "Commands are killed after the timeout and their exit code is reported at the end of the output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      timeout_ms: {
        type: "number",
        description: `Milliseconds before the command is killed. Default ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async run(args, context: ToolContext): Promise<ToolResult> {
    const command = stringArg(args, "command") as string;
    const requested = args.timeout_ms;
    const timeoutMs =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.min(Math.max(requested, 1_000), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    const capture = await runShell(command, context.cwd, timeoutMs, context.signal);

    const parts: string[] = [];
    if (capture.stdout !== "") parts.push(capture.stdout.replace(/\n+$/, ""));
    if (capture.stderr !== "") parts.push(capture.stderr.replace(/\n+$/, ""));
    if (capture.timedOut) parts.push(`[killed after ${timeoutMs} ms]`);
    parts.push(`[exit code: ${capture.code ?? "signal"}]`);

    return {
      output: truncateForModel(parts.join("\n"), MODEL_LIMIT),
      isError: capture.timedOut || capture.code !== 0,
      exitCode: capture.code,
      hook: {
        toolName: "Bash",
        toolInput: { command },
        toolResponse: {
          stdout: truncateForModel(capture.stdout, 100_000),
          stderr: truncateForModel(capture.stderr, 100_000),
        },
        failed: capture.timedOut || capture.code !== 0,
      },
    };
  },
};
