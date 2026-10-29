import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Tool, ToolResult } from "./types.js";
import { ToolInputError, truncateForModel } from "./types.js";

const READ_LIMIT_LINES = 2000;

/** Resolve a tool path and refuse anything outside the workspace, symlinks included. */
export function resolveWorkspacePath(cwd: string, input: string): string {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const rel = relative(cwd, absolute);
  if (escapes(rel)) {
    throw new ToolInputError(`path "${input}" is outside the workspace (${cwd})`);
  }

  // A symlink inside the workspace can still point out of it, so compare real paths.
  const root = safeRealpath(cwd);
  const probe = existsSync(absolute) ? absolute : dirname(absolute);
  if (existsSync(probe)) {
    const real = safeRealpath(probe);
    const relReal = relative(root, real);
    if (escapes(relReal)) {
      throw new ToolInputError(`path "${input}" resolves outside the workspace (${cwd})`);
    }
  }
  return absolute;
}

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel === "" ? "." : rel;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns numbered lines. " +
    `Reads up to ${READ_LIMIT_LINES} lines by default; use offset and limit for large files.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace." },
      offset: { type: "number", description: "First line to read, 1-based. Default 1." },
      limit: { type: "number", description: `How many lines to read. Default ${READ_LIMIT_LINES}.` },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const input = typeof args.path === "string" ? args.path : "";
    if (input === "") throw new ToolInputError('missing required argument "path"');
    const absolute = resolveWorkspacePath(context.cwd, input);

    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      return {
        output: `Could not read ${displayPath(context.cwd, absolute)}: ${messageOf(error)}`,
        isError: true,
        exitCode: null,
        hook: {
          toolName: "Read",
          toolInput: { file_path: absolute },
          toolResponse: {},
          failed: true,
        },
      };
    }

    if (text.includes("\u0000")) {
      return { output: `${input} looks binary; refusing to print it.`, isError: true, exitCode: null };
    }

    const lines = text.split("\n");
    const offset = positiveInt(args.offset) ?? 1;
    const limit = positiveInt(args.limit) ?? READ_LIMIT_LINES;
    const start = Math.min(Math.max(offset - 1, 0), lines.length);
    const slice = lines.slice(start, start + limit);
    const width = String(start + slice.length).length;
    const numbered = slice.map((line, index) => `${String(start + index + 1).padStart(width)}\t${line}`);

    if (slice.length === 0) {
      return { output: `${input} is empty.`, isError: false, exitCode: null };
    }
    if (start + slice.length < lines.length) {
      numbered.push(`… ${lines.length - (start + slice.length)} more lines`);
    }

    return {
      output: truncateForModel(numbered.join("\n")),
      isError: false,
      exitCode: null,
      hook: {
        toolName: "Read",
        toolInput: { file_path: absolute },
        toolResponse: {},
        failed: false,
      },
    };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a text file in the workspace. Parent directories are created.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace." },
      content: { type: "string", description: "Full contents of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const input = typeof args.path === "string" ? args.path : "";
    if (input === "") throw new ToolInputError('missing required argument "path"');
    if (typeof args.content !== "string") throw new ToolInputError('argument "content" must be a string');
    const absolute = resolveWorkspacePath(context.cwd, input);

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, args.content, "utf8");
    const bytes = Buffer.byteLength(args.content, "utf8");

    return {
      output: `Wrote ${bytes} bytes to ${displayPath(context.cwd, absolute)}.`,
      isError: false,
      exitCode: null,
      hook: {
        toolName: "Write",
        toolInput: { file_path: absolute, content: args.content },
        toolResponse: {},
        failed: false,
      },
    };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact fragment of a file. Fails if old_string does not appear exactly once, " +
    "unless replace_all is true. Use it for surgical changes instead of rewriting the file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const input = typeof args.path === "string" ? args.path : "";
    if (input === "") throw new ToolInputError('missing required argument "path"');
    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      throw new ToolInputError('"old_string" and "new_string" must be strings');
    }
    if (args.old_string === "") throw new ToolInputError('"old_string" must not be empty');
    if (args.old_string === args.new_string) {
      throw new ToolInputError('"old_string" and "new_string" are identical');
    }
    const absolute = resolveWorkspacePath(context.cwd, input);

    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      return {
        output: `Could not read ${input}: ${messageOf(error)}`,
        isError: true,
        exitCode: null,
        hook: { toolName: "Edit", toolInput: { file_path: absolute }, toolResponse: {}, failed: true },
      };
    }

    const replaceAll = args.replace_all === true;
    const occurrences = text.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return {
        output: `old_string not found in ${input}.`,
        isError: true,
        exitCode: null,
        hook: { toolName: "Edit", toolInput: { file_path: absolute }, toolResponse: {}, failed: true },
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        output: `old_string appears ${occurrences} times in ${input}; pass replace_all or a longer fragment.`,
        isError: true,
        exitCode: null,
        hook: { toolName: "Edit", toolInput: { file_path: absolute }, toolResponse: {}, failed: true },
      };
    }

    const updated = replaceAll
      ? text.split(args.old_string).join(args.new_string)
      : text.replace(args.old_string, args.new_string);
    await writeFile(absolute, updated, "utf8");

    return {
      output: `Updated ${displayPath(context.cwd, absolute)} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`,
      isError: false,
      exitCode: null,
      hook: {
        toolName: "Edit",
        toolInput: {
          file_path: absolute,
          old_string: args.old_string,
          new_string: args.new_string,
        },
        toolResponse: {},
        failed: false,
      },
    };
  },
};

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
