# cocseak

**A coding harness with no interface.** One command in, one result out.

cocseak exists to be called by something else — a router, a queue, a scheduler, another agent.
It takes a task, runs an agent loop against an OpenAI-compatible model, edits files in a workspace,
and reports back. There is no REPL, no TUI, and no state between runs.

```sh
cocseak --os --title "fix the parser" --task "make the lexer accept trailing commas"
```

Status: pre-alpha. The loop works end to end; the CLI and the wire formats are still settling.

## Why one-shot

Interactive harnesses are built for a person at a keyboard. A router cannot use one: it needs a
process that starts, does the work, exits with a meaningful code, and prints something a program can
parse. That is the whole design constraint here, and it explains most of the choices below.

- **No UI.** `--os` is the only mode. Without it, cocseak tells you what it is and exits.
- **A report, not a transcript.** The result is a compact report — status, files changed, commands
  and their exit codes, decisions — followed by the answer. `--json` prints the same thing as one
  object a program can parse.
- **Documented exit codes.** Timeouts, usage errors, and "the model never finished" are distinct.
- **One workspace.** The agent may only touch files under `--cwd`; paths that escape are refused.
- **Nothing depends on KAP.** When [KAP](https://github.com/Manifestro/kap) is present, the run is
  recorded through its hooks; when it is not, the same session log is still written.

## Install

Requires Node 22 or newer.

```sh
pnpm install
pnpm build
node bin/cocseak.js --help
```

Or link it as a global binary during development:

```sh
pnpm link --global
cocseak --os --task "run the tests and fix what breaks" --cwd .
```

## Usage

```sh
cocseak --os --title <title> --task <task> [options]
cocseak --os --title <title> --task-file <path> [options]
```

`--task-file` exists for routers that would rather not fight shell quoting with a long prompt.

| Flag | Meaning |
| --- | --- |
| `--os` | One-shot mode. Required. |
| `--task <text>` | What to do. Mutually exclusive with `--task-file`. |
| `--task-file <path>` | Read the task from a file. |
| `--title <text>` | Label for the run and for the KAP attempt briefing. Empty is allowed. |
| `--cwd <path>` | Workspace the agent may read and write. Default: the process cwd. |
| `--model <id>` | Model id. Default: `$COCSEAK_MODEL`, `$DEEPSEEK_MODEL`, `deepseek-chat`. |
| `--base-url <url>` | OpenAI-compatible base URL. Default: `$COCSEAK_BASE_URL`, `$DEEPSEEK_BASE_URL`, `https://api.deepseek.com/v1`. |
| `--api-key <key>` | Key. Default: `$COCSEAK_API_KEY`, `$DEEPSEEK_API_KEY`. |
| `--max-turns <n>` | Model turns before the run fails. Default: 50. |
| `--timeout <sec>` | Wall-clock limit. Default: 1800. |
| `--json` | Print the report as one JSON object on stdout. |
| `--answer-only` | Print only the final answer, without the report header. |
| `--report <path>` | Also write the report to a file (JSON, or Markdown if the name ends in `.md`). |
| `--quiet` | No progress on stderr. |
| `--kap <auto\|on\|off>` | KAP adapter. Default: auto. |
| `--no-briefing` | Skip the KAP attempt briefing. |
| `--version`, `--help` | The usual. |

Anything OpenAI-compatible works — DeepSeek is only the default:

```sh
cocseak --os --task "..." \
  --base-url https://openrouter.ai/api/v1 \
  --model qwen/qwen3-coder \
  --api-key "$OPENROUTER_API_KEY"
```

## What the agent can do

| Tool | Purpose |
| --- | --- |
| `bash` | Run a shell command; returns stdout, stderr, and the exit code. Killed on timeout. |
| `read_file` | Read a file with numbered lines, with `offset`/`limit`. |
| `write_file` | Create or overwrite a file; parent directories are created. |
| `edit_file` | Replace an exact fragment; refuses ambiguous matches unless `replace_all`. |
| `glob` | List files matching a glob, skipping `node_modules`, `.git`, `.kap`. |
| `grep` | Search file contents with a regex and an optional `include` glob. |
| `record_decision` | Record a choice, its rationale, and the rejected alternatives — in KAP when present. |

Tool calls run sequentially: a coding agent's actions have order, and parallel writes are a bug
waiting to happen.

## The report

The product of a run is a report, not a transcript. By default it is a few lines of facts followed
by the agent's answer — small enough to paste into another agent's context:

```text
$ cocseak --os --title "lint" --task "fix lint errors"
status: completed · 4 turns · 18.4 s · deepseek-chat
changed: 2 file(s) (+24 -9) · src/cli.ts, src/args.ts
ran: pnpm lint → 0 · pnpm test → 0
decisions: 1
session: /Users/me/.cocseak/sessions/repo-1a2b3c4d/run-20260101T101010-abc123/session.v1.jsonl

Fixed 3 issues: unused import in src/cli.ts, an unreachable branch in src/args.ts, and a
missing case in the lint config. Ran pnpm lint and pnpm test; both pass.
```

`--answer-only` drops the header. `--report <path>` also writes the report to disk — JSON by
default, Markdown when the name ends in `.md`. `--json` prints the report itself:

```json
{
  "report_version": 1,
  "ok": true,
  "status": "completed",
  "title": "lint",
  "task": "fix lint errors",
  "model": "deepseek-chat",
  "cwd": "/repo",
  "answer": "Fixed 3 issues ...",
  "turns": 4,
  "usage": { "prompt_tokens": 9120, "completion_tokens": 1130, "total_tokens": 10250 },
  "duration_ms": 18422,
  "changes": {
    "files": [{ "path": "src/cli.ts", "status": "modified", "added": 12, "removed": 3 }],
    "diff_stat": "2 file(s) changed, 24 insertions(+), 9 deletions(-)"
  },
  "commands": [{ "command": "pnpm test", "exit_code": 0, "duration_ms": 4200 }],
  "decisions": [{ "summary": "...", "rationale": "...", "alternatives": "..." }],
  "session": "/Users/me/.cocseak/sessions/repo-1a2b3c4d/run-.../session.v1.jsonl",
  "kap": { "active": true, "attempt": "attempt-3", "reason": "hooks are recorded for this attempt", "failures": 0 }
}
```

`changes` comes from git when the workspace is a repository (untracked files included), and from
the tool trace otherwise. Files that were already dirty when the run started are left out, so a
nested caller sees what this run changed rather than what was lying around. On failure the same channel carries a report with `ok: false` and an
`error.kind`, so a caller never has to scrape stderr:

```json
{
  "report_version": 1,
  "ok": false,
  "status": "failed",
  "error": { "kind": "timeout", "message": "run timed out" },
  "session": "..."
}
```

| Exit code | Meaning |
| --- | --- |
| 0 | The task finished. |
| 1 | The run failed: provider, tool, or internal error. |
| 2 | Usage or configuration error. |
| 3 | Timeout. |
| 4 | Max turns reached. |
| 130 | Interrupted (SIGINT/SIGTERM). |

## Calling it from another agent

Claude Code and Codex call cocseak as an ordinary shell command; nothing about the nested call is
special, which is the point of one-shot mode:

```sh
cocseak --os --title "parser" --task "make the lexer accept trailing commas" --json --quiet
```

- `--json` when the caller parses the result, `--answer-only` when it only wants the text.
- `--task -` reads the prompt from stdin, so a large prompt does not have to be quoted.
- The exit code tells the caller whether to trust the answer: `3` and `4` mean the agent did not
  finish the job.
- `--report out/report.md` leaves an artifact next to the caller's work.
- A nested run records itself in KAP under its own session id, next to whatever the outer agent
  recorded for the same worktree.

## Recording with KAP

When the working directory is inside a KAP attempt worktree and `kap` is on `PATH`, cocseak reports
to KAP the same way Claude Code does — through KAP's four hooks. A run shows up in `kap log` as
commands, file changes, and decisions, and file writes land as observed evidence:

```text
$ kap log
17:56:37  command   echo hi from cocseak  exit 0  [subagent: cocseak]
17:56:37  decision  use hooks to record
              why: KAP reads them directly
              instead of: kap import cocseak
```

See [docs/KAP.md](docs/KAP.md) for the mapping, the payloads, and what is still missing.

Every run also writes an append-only session log under `~/.cocseak/sessions/` (override with
`COCSEAK_HOME`). It does not depend on KAP and is meant to become the input of a future
`kap import cocseak`.

## Design notes

- **No session continuity.** Every run starts cold. Continuity is the caller's job; a router that
  wants memory passes it in the task or through the KAP briefing.
- **No subagents, no plan mode.** The task is the plan. One model, one loop, one workspace.
- **Workspace confinement is path-based, not a sandbox.** `bash` can still do anything the user can.
  Treat `--cwd` as a contract, not a jail.
- **The session log is the source of truth for what happened.** If KAP and the log ever disagree,
  the log is what the harness saw.

## Roadmap

- [ ] `kap import cocseak` — import the session log, mirroring `kap import dsh`
- [ ] `--resume <session>` — continue a run from its log
- [ ] parallel tool calls where the model asks for them
- [ ] prompt caching for long system prompts
- [ ] an approval policy for write tools (`--read-only`, `--ask`)

## License

MIT © Manifestro
