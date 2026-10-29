import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { UsageError } from "./errors.js";
import type { ChatMessage, Usage } from "./types.js";

export const SESSION_FILE = "session.v1.jsonl";

export type SessionEvent =
  | {
      type: "run_start";
      time: number;
      run_id: string;
      title: string;
      task: string;
      model: string;
      cwd: string;
      /** The run this one continues, when started with `--resume`. */
      resumed_from?: string;
    }
  /** One message added to the conversation, so a later run can resume it exactly. */
  | { type: "message"; time: number; message: ChatMessage }
  /** The whole conversation replaced: at the start of a resumed run, and after compaction. */
  | { type: "history"; time: number; messages: ChatMessage[] }
  | { type: "tool_call"; time: number; call_id: string; name: string; arguments: string }
  | {
      type: "tool_result";
      time: number;
      call_id: string;
      name: string;
      output: string;
      exit_code: number | null;
      is_error: boolean;
    }
  | {
      type: "decision";
      time: number;
      summary: string;
      rationale: string | null;
      alternatives: string | null;
    }
  | {
      type: "run_end";
      time: number;
      ok: boolean;
      turns: number;
      usage: Usage | null;
      answer: string;
      error?: string;
    };

/**
 * Append-only JSONL record of one run.
 *
 * It exists for the router (audit, replay, debugging) and as the input for a future
 * `kap import cocseak`. It is written even when KAP is absent, so the record never depends on
 * the adapter being installed.
 */
export class SessionLog {
  readonly runId: string;
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(directory: string, runId: string) {
    this.runId = runId;
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, SESSION_FILE);
  }

  append(event: SessionEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue
      .then(() => appendFile(this.path, line, "utf8"))
      .catch(() => {
        // A session log that cannot be written must not break the run.
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

/** Run ids sort by time and stay unique across processes. */
export function newRunId(now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${random}`;
}

/** Where cocseak keeps session logs. */
export function sessionsHome(): string {
  return join(process.env.COCSEAK_HOME?.trim() || join(homedir(), ".cocseak"), "sessions");
}

/** The folder holding every run started from `cwd`. */
export function workspaceSessions(cwd: string): string {
  const slug =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return join(sessionsHome(), `${slug}-${hash}`);
}

/**
 * Find the session log `--resume` names: a path to a log or its run folder, a run id, or `last` —
 * the newest run started from `cwd`.
 */
export function findSession(ref: string, cwd: string): string {
  const asPath = resolve(ref);
  if (existsSync(asPath)) {
    const file = statSync(asPath).isDirectory() ? join(asPath, SESSION_FILE) : asPath;
    if (existsSync(file)) return file;
    throw new UsageError(`--resume: no ${SESSION_FILE} in ${asPath}`);
  }

  if (ref === "last") {
    const folder = workspaceSessions(cwd);
    const runs = existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => name.startsWith("run-") && existsSync(join(folder, name, SESSION_FILE)))
          .sort()
      : [];
    const newest = runs.at(-1);
    if (!newest) throw new UsageError(`--resume last: no earlier run was started from ${cwd}`);
    return join(folder, newest, SESSION_FILE);
  }

  const home = sessionsHome();
  if (existsSync(home)) {
    for (const workspace of readdirSync(home)) {
      const file = join(home, workspace, ref, SESSION_FILE);
      if (existsSync(file)) return file;
    }
  }
  throw new UsageError(`--resume: no run "${ref}" (pass a run id, a session path, or "last")`);
}

export interface ResumedSession {
  path: string;
  runId: string;
  title: string;
  task: string;
  cwd: string;
  /** The conversation without its system prompt, ending on a complete turn. */
  messages: ChatMessage[];
  /** Whether the earlier run kept a full transcript; runs before 0.1.3 did not. */
  exact: boolean;
}

/** Rebuild the conversation of an earlier run from its session log. */
export function loadSession(path: string): ResumedSession {
  const events: SessionEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // A torn last line from a killed run: everything before it still counts.
    }
  }

  const start = events.find((event) => event.type === "run_start");
  if (!start || start.type !== "run_start") {
    throw new UsageError(`--resume: ${path} has no run_start; it is not a cocseak session log`);
  }

  let messages: ChatMessage[] = [];
  let exact = false;
  for (const event of events) {
    if (event.type === "history") {
      messages = event.messages.map((message) => ({ ...message }));
      exact = true;
    } else if (event.type === "message") {
      messages.push({ ...event.message });
      exact = true;
    }
  }
  if (!exact) messages = transcriptFromEvents(start.task, events);

  return {
    path,
    runId: start.run_id,
    title: start.title,
    task: start.task,
    cwd: start.cwd,
    messages: completeTurns(messages),
    exact,
  };
}

/**
 * Drop a trailing assistant turn whose tool calls never got their results. A run killed mid-tool
 * leaves one, and the API rejects a conversation that asks for results it never shows.
 */
function completeTurns(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !message.tool_calls?.length) continue;
    const answered = new Set<string>();
    let next = index + 1;
    while (messages[next]?.role === "tool") {
      answered.add(messages[next]?.tool_call_id ?? "");
      next += 1;
    }
    if (!message.tool_calls.every((call) => answered.has(call.id))) {
      end = index;
      break;
    }
  }
  return messages.slice(0, end);
}

/** A plain-text account of a run that kept no transcript: its commands, results, and answer. */
function transcriptFromEvents(task: string, events: SessionEvent[]): ChatMessage[] {
  const lines: string[] = ["An earlier run worked on this task. What it did:"];
  for (const event of events) {
    if (event.type === "tool_call") lines.push(`- called ${event.name} ${event.arguments.slice(0, 300)}`);
    if (event.type === "tool_result") {
      const status = event.is_error ? "failed" : "ok";
      lines.push(`  ${status}: ${event.output.slice(0, 300).replace(/\s+/g, " ")}`);
    }
    if (event.type === "run_end") {
      lines.push(event.ok ? `It finished with: ${event.answer}` : `It stopped: ${event.error ?? "unknown error"}`);
    }
  }
  return [
    { role: "user", content: task },
    { role: "assistant", content: lines.join("\n") },
  ];
}

/** The folder a resumed run's log goes in: next to the run it continues. */
export function resumedSessionDirectory(previous: string, runId: string): string {
  return join(dirname(dirname(previous)), runId);
}
