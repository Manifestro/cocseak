import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "../src/prompt.js";

test("keeps the briefing but drops KAP's CLI instructions", () => {
  const briefing = [
    "KAP attempt attempt-7 is open in this worktree, on branch kap/attempt-7.",
    "Earlier attempts in this repository:\n- attempt-5 (closed) — parser",
    "Record a choice with `kap decision add --summary ...`, and run commands through `kap exec -- <command>` so their output is kept.",
  ].join("\n\n");

  const prompt = buildSystemPrompt({
    cwd: "/repo",
    briefing,
    kapAttempt: "attempt-7",
    toolNames: ["bash", "record_decision"],
  });

  assert.match(prompt, /KAP attempt attempt-7 is open/);
  assert.match(prompt, /Earlier attempts in this repository/);
  assert.doesNotMatch(prompt, /kap exec/);
  assert.doesNotMatch(prompt, /kap decision add/);
  assert.match(prompt, /record_decision/);
});

test("omits the section when there is no briefing", () => {
  const prompt = buildSystemPrompt({
    cwd: "/repo",
    briefing: null,
    kapAttempt: null,
    toolNames: ["bash"],
  });
  assert.doesNotMatch(prompt, /Earlier work in this attempt/);
});
