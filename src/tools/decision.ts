import type { Tool, ToolResult } from "./types.js";
import { ToolInputError } from "./types.js";

/**
 * KAP's model has first-class decisions; Claude Code records them by being told to call
 * `kap decision add`. cocseak gives the model the same capability as a tool, so a decision
 * is an action rather than a line in the prompt that may be ignored.
 */
export const recordDecisionTool: Tool = {
  name: "record_decision",
  description:
    "Record a decision you have committed to: what you chose, why, and what you rejected. " +
    "When KAP is recording this attempt the decision becomes part of its history. " +
    "Call it for choices that shape the change, not for every step.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was decided, in one line." },
      rationale: { type: "string", description: "Why this option is right." },
      alternatives: { type: "string", description: "What else was considered and rejected." },
    },
    required: ["summary"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (summary === "") throw new ToolInputError('missing required argument "summary"');
    const rationale = typeof args.rationale === "string" && args.rationale !== "" ? args.rationale : null;
    const alternatives =
      typeof args.alternatives === "string" && args.alternatives !== "" ? args.alternatives : null;

    const decisionId = await context.kap?.decision(
      summary,
      rationale ?? undefined,
      alternatives ?? undefined,
    );

    return {
      output: decisionId
        ? `Recorded decision ${decisionId} in KAP: ${summary}`
        : `Noted decision (KAP is not recording this run): ${summary}`,
      isError: false,
      exitCode: null,
      decision: { summary, rationale, alternatives },
    };
  },
};
