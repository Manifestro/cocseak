# cocseak

**A coding harness with no interface.** One command in, one report out.

cocseak takes a task, runs a coding agent against an OpenAI-compatible model, edits files in a
workspace, and returns a report: what changed, what it ran, what it decided. It is built to be
called by something else — a router, a queue, or another agent such as Claude Code or Codex — not
to sit open in a terminal.

```sh
cocseak --os --title "fix the parser" --task "make the lexer accept trailing commas"
```

Status: pre-alpha. The loop works end to end; the CLI and the wire formats are still settling.

---

## Start here

From a clean install, this is the whole job:

```sh
cocseak config set api-key sk-...        # once; or export DEEPSEEK_API_KEY
cocseak doctor                           # can it run?
cocseak --os --title "hello" --task "say hello"
```

That is it. The defaults are DeepSeek (`deepseek-chat`, `https://api.deepseek.com/v1`); you only
need to supply a key.

### 1. Give it a key

Either save it, or export it in your shell:

```sh
cocseak config set api-key sk-...        # ~/.cocseak/config.json, chmod 600
export DEEPSEEK_API_KEY=sk-...           # or this; the shell wins over the file
```

`cocseak config` shows what is in effect and where each value comes from. The key is always masked.

### 2. Check that it can run

```sh
cocseak doctor
```

```text
cocseak doctor

config:    /Users/me/.cocseak/config.json (missing)
model:     deepseek-chat (default)
base:      https://api.deepseek.com/v1 (default)
api key:   sk-…b23c (env)
workspace: /Users/me/work/project (not a git repository)
note:      reports will list the files the agent touched, without line counts; run `git init` for exact stats
kap:       kap 0.1.2 — not inside an attempt (run inside .kap/worktrees/<id> to record)
api:       ok — 2 model(s) available

result:    ready
next:      cocseak --os --title "first task" --task "say hello"
```

What each line means:

| line | what it tells you |
| --- | --- |
| `config` | where the settings file is; `(missing)` is fine when the key comes from the environment |
| `model` / `base` | what will actually be used, and whether it came from a flag, env, the config file, or the default |
| `api key` | masked key and its source; `not set` is the one thing that stops a run |
| `workspace` | the directory the agent may edit — the current directory unless you pass `--cwd` |
| `kap` | whether KAP will record this run; not being in an attempt is normal outside KAP |
| `api` | a real request to the provider: is the URL reachable and the key accepted |
| `result` | `ready` means "go run a task"; `not ready` lists what to fix |

`--offline` skips the provider check when you have no network.

### 3. Run a task

```sh
cd ~/work/project
cocseak --os --title "notes" --task "create NOTES.md with a short summary of this repository"
```

You get a report, then the agent's answer:

```text
status: completed · 3 turns · 12.4 s · deepseek-chat
changed: 1 file(s) (+12 -0) · NOTES.md
ran: ls → 0 · cat package.json → 0
session: /Users/me/.cocseak/sessions/project-1a2b3c4d/run-20260101T101010-abc123/session.v1.jsonl

Created NOTES.md ... (the agent's report)
```

- `status` — finished, in how many model turns, how long, on which model;
- `changed` — files changed. Exact line counts come from git; in a plain directory the list comes
  from what the agent touched, so `git init` is worth it;
- `ran` — every shell command with its exit code;
- `session` — the full JSONL log of the run, on disk;
- then the answer itself.

### If something is off

| what you see | what to do |
| --- | --- |
| `not ready` / `no API key` | `cocseak config set api-key sk-...`, or export `DEEPSEEK_API_KEY` |
| `HTTP 401 — the key was rejected` | the key is wrong or from another provider; set a new one |
| `workspace: ... (not a git repository)` | optional: `git init` so `changed` includes +/− line counts |
| `kap: ... not inside an attempt` | optional: see [Recording with KAP](#recording-with-kap) |
| exit code `3` | the run hit `--timeout`; raise it for long builds |
| exit code `4` | the model used all `--max-turns`; raise it or split the task |
| exit code `1` | the run failed; the message above says why |

---

## Install

Requires Node 22 or newer.

```sh
git clone https://github.com/Manifestro/cocseak.git
cd cocseak
pnpm install
pnpm build
npm install -g .            # puts `cocseak` on your PATH
cocseak --version
```

For development, `node bin/cocseak.js ...` works without installing.

## Settings

Stored in `~/.cocseak/config.json` (override the directory with `COCSEAK_HOME`):

```json
{
  "api_key": "sk-...",
  "model": "deepseek-chat",
  "base_url": "https://api.deepseek.com/v1",
  "max_turns": 50,
  "timeout_seconds": 1800
}
```

```sh
cocseak config                        # effective values and their sources
cocseak config path                   # the file being read
cocseak config set model deepseek-reasoner
cocseak config set base-url https://openrouter.ai/api/v1
cocseak config set api-key sk-...
cocseak config unset api-key
```

Precedence, highest first: **flags → environment → settings file → defaults**. Anything
OpenAI-compatible works — DeepSeek is only the default:

```sh
cocseak --os --task "..." \
  --base-url https://openrouter.ai/api/v1 \
  --model qwen/qwen3-coder \
  --api-key "$OPENROUTER_API_KEY"
```

## Usage

```sh
cocseak --os --title <title> --task <task> [options]
cocseak --os --title <title> --task-file <path> [options]
cocseak config [show|path|set|unset]
cocseak doctor [--offline]
```

| Flag | Meaning |
| --- | --- |
| `--os` | One-shot mode. Required. |
| `--task <text>` | What to do. Mutually exclusive with `--task-file`. `-` reads stdin. |
| `--task-file <path>` | Read the task from a file. `-` reads stdin. |
| `--title <text>` | Label for the run. Empty is allowed. Defaults to the directory name. |
| `--cwd <path>` | Workspace the agent may read and write. Default: the process cwd. |
| `--model <id>` | Model id. Default: `$COCSEAK_MODEL`, `$DEEPSEEK_MODEL`, `deepseek-chat`. |
| `--base-url <url>` | OpenAI-compatible base URL. Default: `$COCSEAK_BASE_URL`, `$DEEPSEEK_BASE_URL`, `https://api.deepseek.com/v1`. |
| `--api-key <key>` | Key. Default: `$COCSEAK_API_KEY`, `$DEEPSEEK_API_KEY`, the settings file. |
| `--max-turns <n>` | Model turns before the run fails. Default: 50. |
| `--timeout <sec>` | Wall-clock limit. Default: 1800. |
| `--json` | Print the report as one JSON object on stdout. |
| `--answer-only` | Print only the final answer, without the report header. |
| `--report <path>` | Also write the report to a file (JSON, or Markdown if the name ends in `.md`). |
| `--quiet` | No progress on stderr. |
| `--kap <auto\|on\|off>` | KAP adapter. Default: auto. |
| `--no-briefing` | Skip the KAP attempt briefing. |
| `--version`, `--help` | The usual. |

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

The product of a run is a report, not a transcript. `--json` prints it as one object:

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
nested caller sees what this run changed rather than what was lying around.

On failure the same channel carries a report with `ok: false`:

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

[KAP](https://github.com/Manifestro/kap) records what an agent did: commands, file changes,
decisions, evidence. cocseak reports through KAP's hooks, the same way Claude Code does, and only
when it runs inside an attempt worktree:

```sh
kap attempt start fix-parser --task "make the parser accept trailing commas"
cd .kap/worktrees/attempt-...
cocseak --os --title "parser" --task "make the parser accept trailing commas"
kap log
```

```text
18:16:25  command   pnpm test  exit 0  [subagent: cocseak]
18:16:25  file_change Write src/lexer.ts  [subagent: cocseak]
```

File writes also become observed evidence with the file's hash, and `kap status` shows the count.
`cocseak doctor` tells you whether recording is on. The full adapter design, payloads, and known
gaps are in [docs/KAP.md](docs/KAP.md).

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
