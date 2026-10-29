import type { ChangeSet } from "./git.js";
import type { Usage } from "./types.js";

export interface CommandTrace {
  command: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface DecisionTrace {
  summary: string;
  rationale: string | null;
  alternatives: string | null;
}

export interface ChangeTrace {
  path: string;
  action: "write" | "edit";
}

export interface ReportInput {
  title: string;
  task: string;
  model: string;
  cwd: string;
  answer: string;
  turns: number;
  usage: Usage;
  duration_ms: number;
  session: string;
  kap: Record<string, unknown>;
  changes: ChangeSet;
  commit: string | null;
  commands: CommandTrace[];
  decisions: DecisionTrace[];
}

export interface FailureInput {
  title: string;
  model: string;
  cwd: string;
  session: string | null;
  kind: "usage" | "config" | "timeout" | "max_turns" | "provider" | "tool" | "interrupted" | "internal";
  message: string;
}

export interface Report extends ReportInput {
  report_version: 1;
  ok: true;
  status: "completed";
}

export interface FailureReport {
  report_version: 1;
  ok: false;
  status: "failed";
  title: string;
  model: string;
  cwd: string;
  session: string | null;
  error: { kind: FailureInput["kind"]; message: string };
}

/**
 * The report is the product of a one-shot run.
 *
 * A caller — Claude Code, Codex, a router — gets what changed, what was run, what was decided, and
 * how the run ended, without re-reading the transcript or diffing the tree itself.
 */
export function buildReport(input: ReportInput): Report {
  return {
    report_version: 1,
    ok: true,
    status: "completed",
    ...input,
    commands: input.commands.slice(0, 100),
    decisions: input.decisions.slice(0, 50),
  };
}

export function buildFailureReport(input: FailureInput): FailureReport {
  return {
    report_version: 1,
    ok: false,
    status: "failed",
    title: input.title,
    model: input.model,
    cwd: input.cwd,
    session: input.session,
    error: { kind: input.kind, message: input.message },
  };
}

/** Compact enough to paste into another agent's context. */
export function renderText(report: Report): string {
  const lines: string[] = [];

  lines.push(
    `status: ${report.status} · ${report.turns} turn${report.turns === 1 ? "" : "s"} · ${formatDuration(report.duration_ms)} · ${report.model}`,
  );

  if (report.changes.files.length === 0) {
    lines.push("changed: none");
  } else {
    const totalAdded = report.changes.files.reduce((sum, file) => sum + file.added, 0);
    const totalRemoved = report.changes.files.reduce((sum, file) => sum + file.removed, 0);
    const names = report.changes.files.slice(0, 5).map((file) => file.path);
    const more = report.changes.files.length > names.length ? `, +${report.changes.files.length - names.length} more` : "";
    lines.push(
      `changed: ${report.changes.files.length} file(s) (+${totalAdded} -${totalRemoved}) · ${names.join(", ")}${more}`,
    );
  }

  if (report.commands.length > 0) {
    const shown = report.commands.slice(0, 6).map((command) => `${oneliner(command.command, 80)} → ${command.exit_code ?? "no exit"}`);
    const more = report.commands.length > shown.length ? ` · +${report.commands.length - shown.length} more` : "";
    lines.push(`ran: ${shown.join(" · ")}${more}`);
  }

  if (report.decisions.length > 0) {
    lines.push(`decisions: ${report.decisions.length}`);
  }
  if (report.commit) lines.push(`commit: ${report.commit}`);
  lines.push(`session: ${report.session}`);
  if (report.kap.active === true) {
    lines.push(`kap: ${String(report.kap.attempt ?? "recorded")}`);
  }

  lines.push("", report.answer);
  return `${lines.join("\n")}\n`;
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [`# cocseak report: ${report.title}`, ""];

  lines.push(`- status: **${report.status}**`);
  lines.push(`- model: \`${report.model}\``);
  lines.push(`- turns: ${report.turns} in ${formatDuration(report.duration_ms)}`);
  lines.push(`- workspace: \`${report.cwd}\``);
  if (report.commit) lines.push(`- commit: \`${report.commit}\``);
  lines.push(`- session: \`${report.session}\``);
  if (report.kap.active === true) {
    lines.push(`- kap attempt: \`${String(report.kap.attempt ?? "")}\``);
  }
  lines.push("", "## Answer", "", report.answer, "");

  lines.push("## Changes", "");
  if (report.changes.files.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("| file | status | + | − |", "| --- | --- | --- | --- |");
    for (const file of report.changes.files) {
      lines.push(`| \`${file.path}\` | ${file.status} | ${file.added} | ${file.removed} |`);
    }
    lines.push("");
  }

  lines.push("## Commands", "");
  if (report.commands.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push("| command | exit | duration |", "| --- | --- | --- |");
    for (const command of report.commands) {
      lines.push(
        `| \`${command.command.replace(/\|/g, "\\|")}\` | ${command.exit_code ?? "—"} | ${formatDuration(command.duration_ms)} |`,
      );
    }
    lines.push("");
  }

  if (report.decisions.length > 0) {
    lines.push("## Decisions", "");
    for (const decision of report.decisions) {
      lines.push(`- **${decision.summary}**`);
      if (decision.rationale) lines.push(`  - why: ${decision.rationale}`);
      if (decision.alternatives) lines.push(`  - instead of: ${decision.alternatives}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function oneliner(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
