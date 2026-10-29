import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { Usage } from "./types.js";

export type SessionEvent =
  | { type: "run_start"; time: number; run_id: string; title: string; task: string; model: string; cwd: string }
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
    this.path = join(directory, "session.v1.jsonl");
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
