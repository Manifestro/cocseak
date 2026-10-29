import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Tool, ToolResult } from "./types.js";
import { ToolInputError, truncateForModel } from "./types.js";
import { matchesGlob, walkFiles } from "./walk.js";

const MAX_GLOB_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const MAX_FILE_BYTES = 1024 * 1024;

function rootArg(args: Record<string, unknown>, cwd: string): string {
  const input = typeof args.path === "string" && args.path !== "" ? args.path : ".";
  return resolve(cwd, input);
}

export const globTool: Tool = {
  name: "glob",
  description:
    "List files in the workspace matching a glob pattern (e.g. `src/**/*.ts`, `*.md`). " +
    "Skips node_modules, .git and .kap.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern. `**` crosses directories." },
      path: { type: "string", description: "Directory to search from. Default: the workspace." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    if (typeof args.pattern !== "string" || args.pattern === "") {
      throw new ToolInputError('missing required argument "pattern"');
    }
    const pattern = args.pattern;
    const root = rootArg(args, context.cwd);

    const found: string[] = [];
    for await (const file of walkFiles(root)) {
      if (matchesGlob(file.relative, pattern)) found.push(file.relative);
      if (found.length >= MAX_GLOB_RESULTS + 1) break;
    }
    found.sort();

    if (found.length === 0) {
      return {
        output: `No files match ${pattern}.`,
        isError: false,
        exitCode: null,
        hook: {
          toolName: "Glob",
          toolInput: { pattern, path: args.path ?? "." },
          toolResponse: {},
          failed: false,
        },
      };
    }

    const truncated = found.length > MAX_GLOB_RESULTS;
    const shown = found.slice(0, MAX_GLOB_RESULTS);
    const lines = truncated
      ? [...shown, `… more than ${MAX_GLOB_RESULTS} matches; narrow the pattern`]
      : shown;

    return {
      output: lines.join("\n"),
      isError: false,
      exitCode: null,
      hook: {
        toolName: "Glob",
        toolInput: { pattern, path: args.path ?? "." },
        toolResponse: {},
        failed: false,
      },
    };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression and print file:line matches. " +
    "Optionally restrict files with an `include` glob such as `*.ts`.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      include: { type: "string", description: "Only search files matching this glob." },
      path: { type: "string", description: "Directory to search from. Default: the workspace." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    if (typeof args.pattern !== "string" || args.pattern === "") {
      throw new ToolInputError('missing required argument "pattern"');
    }

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (error) {
      throw new ToolInputError(`invalid regular expression: ${(error as Error).message}`);
    }

    const include = typeof args.include === "string" && args.include !== "" ? args.include : undefined;
    const root = rootArg(args, context.cwd);
    const matches: string[] = [];

    for await (const file of walkFiles(root)) {
      if (include && !matchesGlob(file.relative, include)) continue;
      if (file.relative.split("/").some((part) => part === "dist" && include === undefined)) {
        // `dist` is generated code; searching it by default buries the real hits.
        continue;
      }

      let text: string;
      try {
        const stat = await readFile(file.absolute);
        if (stat.byteLength > MAX_FILE_BYTES) continue;
        text = stat.toString("utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;

      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (!regex.test(line)) continue;
        const snippet = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        matches.push(`${file.relative}:${index + 1}: ${snippet}`);
        if (matches.length >= MAX_GREP_MATCHES) break;
      }
      if (matches.length >= MAX_GREP_MATCHES) break;
    }

    const result: ToolResult = {
      output:
        matches.length === 0
          ? `No matches for /${args.pattern}/.`
          : truncateForModel(matches.join("\n")),
      isError: false,
      exitCode: null,
      hook: {
        toolName: "Grep",
        toolInput: { pattern: args.pattern, path: args.path ?? "." },
        toolResponse: {},
        failed: false,
      },
    };
    return result;
  },
};
