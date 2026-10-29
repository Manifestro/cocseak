import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "../src/args.js";
import { UsageError } from "../src/errors.js";

test("parses a one-shot invocation", () => {
  const options = parseCliArgs(["--os", "--title", "fix parser", "--task", "make it pass"]);
  assert.equal(options.oneShot, true);
  assert.equal(options.title, "fix parser");
  assert.equal(options.task, "make it pass");
  assert.equal(options.kap, "auto");
  assert.equal(options.json, false);
});

test("defaults", () => {
  const options = parseCliArgs(["--os", "--task", "x"]);
  assert.equal(options.title, undefined);
  assert.equal(options.maxTurns, undefined);
  assert.equal(options.timeoutMs, undefined);
  assert.equal(options.briefing, true);
});

test("task and task-file are mutually exclusive", () => {
  assert.throws(
    () => parseCliArgs(["--os", "--task", "a", "--task-file", "b"]),
    UsageError,
  );
});

test("rejects non-numeric max turns", () => {
  assert.throws(() => parseCliArgs(["--os", "--task", "x", "--max-turns", "many"]), UsageError);
  assert.throws(() => parseCliArgs(["--os", "--task", "x", "--max-turns", "0"]), UsageError);
});

test("converts timeout seconds to milliseconds", () => {
  const options = parseCliArgs(["--os", "--task", "x", "--timeout", "90"]);
  assert.equal(options.timeoutMs, 90_000);
});

test("rejects unknown kap modes", () => {
  assert.throws(() => parseCliArgs(["--os", "--task", "x", "--kap", "yes"]), UsageError);
});

test("rejects unknown flags", () => {
  assert.throws(() => parseCliArgs(["--os", "--task", "x", "--nope"]), UsageError);
});
