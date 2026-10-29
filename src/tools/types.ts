import type { HookEvent, KapAdapter } from "../kap.js";

export interface ToolContext {
  cwd: string;
  kap: KapAdapter | null;
  signal: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  exitCode: number | null;
  /** What the KAP adapter should report for this call, if it succeeded in producing one. */
  hook?: HookEvent;
  /** Set by `record_decision` so the run can log it and the adapter can store it. */
  decision?: { summary: string; rationale: string | null; alternatives: string | null };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function errorResult(message: string): ToolResult {
  return { output: message, isError: true, exitCode: null };
}

/** Keep a tool's output small enough for a context window without hiding the end of it. */
export function truncateForModel(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}\n… [truncated ${text.length - limit} chars] …\n${text.slice(-tail)}`;
}

export function stringArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined) {
    if (required) throw new ToolInputError(`missing required argument "${name}"`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolInputError(`argument "${name}" must be a string`);
  return value;
}
