import type { ToolSchema } from "../types.js";
import { bashTool } from "./bash.js";
import { recordDecisionTool } from "./decision.js";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { globTool, grepTool } from "./search.js";
import type { Tool } from "./types.js";

export const TOOLS: readonly Tool[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  recordDecisionTool,
];

export function toolSchemas(tools: readonly Tool[] = TOOLS): ToolSchema[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function findTool(name: string, tools: readonly Tool[] = TOOLS): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

/** The name KAP's hook parser expects for a given cocseak tool. */
export function hookNameFor(tool: string): string {
  switch (tool) {
    case "bash":
      return "Bash";
    case "read_file":
      return "Read";
    case "write_file":
      return "Write";
    case "edit_file":
      return "Edit";
    case "glob":
      return "Glob";
    case "grep":
      return "Grep";
    default:
      return tool;
  }
}
