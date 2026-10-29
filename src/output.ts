import type { Usage } from "./types.js";

export interface SuccessReport {
  ok: true;
  version: string;
  title: string;
  model: string;
  cwd: string;
  answer: string;
  turns: number;
  usage: Usage;
  duration_ms: number;
  session: string;
  kap: Record<string, unknown>;
}

export interface FailureReport {
  ok: false;
  version: string;
  error: { kind: "usage" | "config" | "timeout" | "max_turns" | "provider" | "tool" | "interrupted" | "internal"; message: string };
  session: string | null;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_TIMEOUT = 3;
export const EXIT_MAX_TURNS = 4;
export const EXIT_INTERRUPTED = 130;
