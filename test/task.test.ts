import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { UsageError } from "../src/errors.js";
import { resolveTask } from "../src/task.js";
import { tempDir } from "./helpers.js";

test("takes the task from --task", () => {
  assert.equal(resolveTask({ task: "fix it", taskFile: undefined }), "fix it");
});

test("takes the task from --task-file", () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "task.md");
    writeFileSync(path, "from a file\n");
    assert.equal(resolveTask({ task: undefined, taskFile: path }), "from a file\n");
  } finally {
    dir.cleanup();
  }
});

test("reads a piped task when the value is -", () => {
  assert.equal(resolveTask({ task: "-", taskFile: undefined }, "piped task"), "piped task");
  assert.equal(resolveTask({ task: undefined, taskFile: "-" }, "piped file"), "piped file");
});

test("requires a task", () => {
  assert.throws(() => resolveTask({ task: undefined, taskFile: undefined }), UsageError);
});
