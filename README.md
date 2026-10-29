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
- **Machine-readable.** `--json` prints exactly one JSON object on stdout. Progress goes to stderr.
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
| `--json` | One JSON object on stdout. |
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

## Output

Text mode prints the agent's final answer on stdout and nothing else:

```sh
$ cocseak --os --title "lint" --task "fix lint errors"
Fixed 3 issues: unused import in src/cli.ts, ...
Ran: pnpm lint (exit 0)
```

With `--json`, stdout is a single object:

```json
{
  "ok": true,
  "version": "0.0.0",
  "title": "lint",
  "model": "deepseek-chat",
  "cwd": "/repo",
  "answer": "Fixed 3 issues ...",
  "turns": 4,
  "usage": { "prompt_tokens": 9120, "completion_tokens": 1130, "total_tokens": 10250 },
  "duration_ms": 18422,
  "session": "/Users/me/.cocseak/sessions/repo-1a2b3c4d/run-20260101T101010-abc123/session.v1.jsonl",
  "kap": { "active": true, "attempt": "attempt-3", "reason": "hooks are recorded for this attempt", "failures": 0 }
}
```

On failure the same channel carries the error, so a router never has to scrape stderr:

```json
{ "ok": false, "version": "0.0.0", "error": { "kind": "timeout", "message": "run timed out" }, "session": "..." }
```

| Exit code | Meaning |
| --- | --- |
| 0 | The task finished. |
| 1 | The run failed: provider, tool, or internal error. |
| 2 | Usage or configuration error. |
| 3 | Timeout. |
| 4 | Max turns reached. |
| 130 | Interrupted (SIGINT/SIGTERM). |

## Recording with KAP

When the working directory is inside a KAP attempt worktree and `kap` is on `PATH`, cocseak reports
to KAP the same way Claude Code does — through KAP's hooks. See [docs/KAP.md](docs/KAP.md) for the
mapping, the payloads, and what is still missing.

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
