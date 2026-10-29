import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bashTool } from "../src/tools/bash.js";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/files.js";
import { globTool, grepTool } from "../src/tools/search.js";
import type { ToolContext } from "../src/tools/types.js";
import { tempDir } from "./helpers.js";

const context = (cwd: string): ToolContext => ({ cwd, kap: null, signal: new AbortController().signal });

test("writes and reads a file with line numbers", async () => {
  const dir = tempDir();
  try {
    const write = await writeFileTool.run(
      { path: "src/a.ts", content: "one\ntwo\nthree\n" },
      context(dir.path),
    );
    assert.equal(write.isError, false);
    assert.equal(readFileSync(join(dir.path, "src/a.ts"), "utf8"), "one\ntwo\nthree\n");

    const read = await readFileTool.run({ path: "src/a.ts", offset: 2, limit: 1 }, context(dir.path));
    assert.match(read.output, /^2\ttwo$/m);

    const hook = write.hook;
    assert.equal(hook?.toolName, "Write");
    assert.equal(hook?.toolInput.file_path, join(dir.path, "src/a.ts"));
  } finally {
    dir.cleanup();
  }
});

test("edit_file replaces exactly and refuses ambiguity", async () => {
  const dir = tempDir();
  try {
    await writeFileTool.run({ path: "a.txt", content: "x = 1;\nx = 2;\n" }, context(dir.path));

    const ambiguous = await editFileTool.run(
      { path: "a.txt", old_string: "x = ", new_string: "y = " },
      context(dir.path),
    );
    assert.equal(ambiguous.isError, true);

    const ok = await editFileTool.run(
      { path: "a.txt", old_string: "x = 1", new_string: "y = 1" },
      context(dir.path),
    );
    assert.equal(ok.isError, false);
    assert.equal(readFileSync(join(dir.path, "a.txt"), "utf8"), "y = 1;\nx = 2;\n");
  } finally {
    dir.cleanup();
  }
});

test("refuses paths outside the workspace", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      () => readFileTool.run({ path: "../../etc/passwd" }, context(dir.path)),
      /outside the workspace/,
    );
  } finally {
    dir.cleanup();
  }
});

test("glob and grep find nested files and skip node_modules", async () => {
  const dir = tempDir();
  try {
    await writeFileTool.run({ path: "src/deep/a.ts", content: "export const alpha = 1;\n" }, context(dir.path));
    await writeFileTool.run({ path: "src/b.md", content: "alpha docs\n" }, context(dir.path));
    await writeFileTool.run(
      { path: "node_modules/pkg/c.ts", content: "export const alpha = 2;\n" },
      context(dir.path),
    );

    const globbed = await globTool.run({ pattern: "src/**/*.ts" }, context(dir.path));
    assert.match(globbed.output, /src\/deep\/a\.ts/);
    assert.doesNotMatch(globbed.output, /b\.md/);

    const grepped = await grepTool.run({ pattern: "alpha", include: "*.ts" }, context(dir.path));
    assert.match(grepped.output, /src\/deep\/a\.ts:1:/);
    assert.doesNotMatch(grepped.output, /node_modules/);
  } finally {
    dir.cleanup();
  }
});

test("bash reports stdout, stderr, and the exit code", async () => {
  const dir = tempDir();
  try {
    const ok = await bashTool.run({ command: "echo hello" }, context(dir.path));
    assert.equal(ok.isError, false);
    assert.match(ok.output, /hello/);
    assert.match(ok.output, /\[exit code: 0\]/);
    assert.equal(ok.hook?.toolName, "Bash");
    assert.equal(ok.hook?.toolResponse.stdout, "hello\n");

    const bad = await bashTool.run({ command: "echo boom >&2; exit 3" }, context(dir.path));
    assert.equal(bad.isError, true);
    assert.equal(bad.exitCode, 3);
    assert.match(bad.output, /boom/);
    assert.match(bad.output, /\[exit code: 3\]/);
    assert.equal(bad.hook?.failed, true);
  } finally {
    dir.cleanup();
  }
});
