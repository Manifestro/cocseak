import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { UsageError } from "./errors.js";

export interface TaskSource {
  task: string | undefined;
  taskFile: string | undefined;
}

/**
 * Resolve the task from `--task`, `--task-file`, or stdin.
 *
 * `--task -` exists for callers that already have the prompt in a pipe — another agent running
 * `echo ... | cocseak --os --task -` does not have to quote anything.
 */
export function resolveTask(source: TaskSource, stdin = ""): string {
  if (source.taskFile !== undefined && source.taskFile !== "") {
    if (source.taskFile === "-") return stdin;
    try {
      return readFileSync(resolve(source.taskFile), "utf8");
    } catch (error) {
      throw new UsageError(`could not read --task-file: ${(error as Error).message}`);
    }
  }

  if (source.task === undefined) {
    throw new UsageError("missing --task (or --task-file)");
  }
  if (source.task === "-") return stdin;
  return source.task;
}
