import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFailureReport, buildReport, renderMarkdown, renderText } from "../src/report.js";

const report = buildReport({
  title: "fix parser",
  task: "make it pass",
  model: "deepseek-chat",
  cwd: "/repo",
  answer: "Fixed the lexer.\nRan the tests.",
  turns: 3,
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  duration_ms: 12_400,
  session: "/home/me/.cocseak/sessions/repo-1234/run-1/session.v1.jsonl",
  kap: { active: true, attempt: "attempt-7" },
  commit: "abc1234",
  changes: {
    files: [{ path: "src/lexer.ts", status: "modified", added: 10, removed: 2 }],
    diff_stat: "1 file(s) changed, 10 insertions(+), 2 deletions(-)",
  },
  commands: [{ command: "pnpm test", exit_code: 0, duration_ms: 4200 }],
  decisions: [{ summary: "normalize in the lexer", rationale: "parser stays simple", alternatives: "fix in parser" }],
});

test("the text report is compact and starts with the facts", () => {
  const text = renderText(report);
  assert.match(text, /^status: completed · 3 turns · 12\.4 s · deepseek-chat$/m);
  assert.match(text, /^changed: 1 file\(s\) \(\+10 -2\) · src\/lexer\.ts$/m);
  assert.match(text, /^ran: pnpm test → 0$/m);
  assert.match(text, /^decisions: 1$/m);
  assert.match(text, /^commit: abc1234$/m);
  assert.match(text, /^kap: attempt-7$/m);
  assert.match(text, /Fixed the lexer\.\nRan the tests\.\n$/);
});

test("the markdown report carries tables", () => {
  const md = renderMarkdown(report);
  assert.match(md, /^# cocseak report: fix parser$/m);
  assert.match(md, /\| `src\/lexer\.ts` \| modified \| 10 \| 2 \|/);
  assert.match(md, /\| `pnpm test` \| 0 \| 4\.2 s \|/);
  assert.match(md, /\*\*normalize in the lexer\*\*/);
});

test("an empty run says so", () => {
  const empty = buildReport({ ...report, changes: { files: [], diff_stat: "no changes detected" }, commands: [], decisions: [] });
  const text = renderText(empty);
  assert.match(text, /^changed: none$/m);
  assert.doesNotMatch(text, /^ran:/m);
});

test("failure reports keep the same envelope", () => {
  const failure = buildFailureReport({
    title: "fix parser",
    model: "deepseek-chat",
    cwd: "/repo",
    session: null,
    kind: "timeout",
    message: "run timed out",
  });
  assert.equal(failure.report_version, 1);
  assert.equal(failure.ok, false);
  assert.equal(failure.status, "failed");
  assert.equal(failure.error.kind, "timeout");
});
