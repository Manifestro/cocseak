import { hostname, platform, release } from "node:os";

/**
 * KAP's briefing ends by telling the agent to run commands through `kap exec` and to record
 * decisions with the CLI. For cocseak that is wrong on both counts: tool calls are recorded by the
 * hooks already, and decisions go through the `record_decision` tool. Left in, the model wraps
 * every command in `kap exec`, recording each one twice.
 */
function sanitizeBriefing(briefing: string): string {
  return briefing
    .split(/\n{2,}/)
    .filter((paragraph) => !/kap exec|kap decision add|kap evidence attach/.test(paragraph))
    .join("\n\n")
    .trim();
}

export interface PromptInput {
  cwd: string;
  briefing: string | null;
  kapAttempt: string | null;
  toolNames: readonly string[];
  /** The turn budget; the model plans better when it knows it. */
  maxTurns?: number;
}

export function buildSystemPrompt(input: PromptInput): string {
  const lines: string[] = [
    "You are cocseak, a coding agent running headless in one shot. No human is watching the",
    "conversation: do the work, verify it, and finish. Never ask questions — if something is",
    "ambiguous, make the smallest reasonable assumption and say so in the final answer.",
    "",
    "## Environment",
    `- Workspace: ${input.cwd}`,
    `- Platform: ${platform()} ${release()} (${hostname()})`,
    `- Tools: ${input.toolNames.join(", ")}`,
    "",
    "## Rules",
    "- Work only inside the workspace. Read before you edit; prefer edit_file over rewriting.",
    "- Use bash for builds, tests, git, and checks. Look at the exit code before claiming success.",
    "- When a command fails, read the error and fix the cause, not the symptom.",
    "- Keep changes minimal and consistent with the surrounding code.",
    "- Stop when the task is done or you are blocked. The final message is the report:",
    "  what you changed, how you verified it, and anything left undone.",
    "- Cite the commands you ran in the report, so the result can be checked.",
    "- Edit files with edit_file or write_file, not with scripts that rewrite them: the record of",
    "  each change, and the diff someone reviews, come from those tools.",
    "- Verify once, at the end: run the relevant tests and lints. Do not re-read a file you just",
    "  wrote or re-run a check that already passed.",
    "- When the checks pass, stop and report. Do not polish, reformat, or refactor beyond the task.",
    "- Call independent tools together in one turn; each turn counts against the budget.",
  ];

  if (input.maxTurns !== undefined) {
    lines.push(
      "",
      "## Budget",
      `You have ${input.maxTurns} turns; a turn is one reply, however many tools it calls. Spend`,
      "them on the change, not on re-checking it. Near the end you will be told to wrap up, and",
      "when they run out tools switch off and you write the report.",
    );
  }

  if (input.kapAttempt) {
    lines.push(
      "",
      "## KAP",
      `This run is recorded in KAP attempt ${input.kapAttempt}. Every tool call is reported to`,
      "KAP as it happens, and file writes are hashed as evidence.",
      "When you commit to a choice that shapes the change — an approach, a protocol, a tradeoff —",
      "call record_decision with the summary, the rationale, and what you rejected.",
      "Do not use it for routine steps; it is for choices someone will want to understand later.",
    );
  }

  if (input.briefing && input.briefing.trim() !== "") {
    lines.push("", "## Earlier work in this attempt", sanitizeBriefing(input.briefing));
  }

  return `${lines.join("\n")}\n`;
}
