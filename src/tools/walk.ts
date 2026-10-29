import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";

export const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".kap",
  ".cocseak",
  "node_modules",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

const MAX_ENTRIES = 50_000;

/** Every file under `root`, skipping dependency and VCS directories. */
export async function* walkFiles(root: string): AsyncGenerator<{ absolute: string; relative: string }> {
  let seen = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      continue;
    }

    for await (const entry of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(absolute);
      } else if (entry.isFile()) {
        yield { absolute, relative: relative(root, absolute) };
      }
    }
  }
}

/** Translate a glob to a regexp: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          out += "(?:[^/]+/)*";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(relativePath: string, pattern: string): boolean {
  const regex = globToRegExp(pattern);
  const normalized = relativePath.split("\\").join("/");
  if (regex.test(normalized)) return true;
  if (!pattern.includes("/")) {
    const base = normalized.split("/").pop() ?? normalized;
    return regex.test(base);
  }
  return false;
}
