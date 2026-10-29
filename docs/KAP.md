# Recording cocseak in KAP

KAP does not wrap agents and does not own their loop. It records observable work through
*adapters*. For Claude Code the adapter is a set of hooks written into `settings.json`: KAP is
called at four points and answers with JSON on stdout.

cocseak uses the same four hooks, but there is no settings file to install. A one-shot process
already knows its own lifecycle, so it calls the hooks itself.

## Lifecycle

| cocseak moment | KAP command | Effect in KAP |
| --- | --- | --- |
| run starts | `kap hook session-start` | Prints the attempt briefing; cocseak injects it into the system prompt. |
| a tool finishes | `kap hook post-tool-use` | Records a `ToolEvent`. For `Write`/`Edit`, also hashes the file and records `file_change` evidence. |
| a tool fails | `kap hook post-tool-use-failure` | Records the failure. No exit code is invented. |
| `record_decision` | `kap decision add` | Records the summary, rationale, and rejected alternatives. |
| run ends | `kap hook stop` | Finishes the run, snapshots changed files as evidence. |
| run ends (KAP active) | `git commit` in the worktree | Puts the result on the attempt branch, so review and merge can carry it. `--no-commit` skips it. |

Everything else KAP does — attempts, worktrees, review, merge, sync — is untouched by cocseak.

## Payload

Hooks receive one JSON object on stdin. cocseak sends the fields KAP parses:

```json
{
  "session_id": "run-20260101T101010-abc123",
  "cwd": "/repo/.kap/worktrees/attempt-3",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "pnpm test" },
  "tool_response": { "stdout": "...", "stderr": "" },
  "tool_use_id": "call_1",
  "agent_type": "cocseak"
}
```

`tool_use_id` matters: KAP derives the event id from the attempt, the session, and the call id, so
a retried hook cannot double the history. `session_id` becomes the KAP run id — one cocseak process
is exactly one run.

## Tool names

KAP's hook parser knows Claude Code's tool names, so cocseak uses them on the wire:

| cocseak tool | `tool_name` | What KAP does |
| --- | --- | --- |
| `bash` | `Bash` | `command` event with stdout/stderr as content-addressed objects |
| `read_file` | `Read` | `tool_call` event |
| `write_file` | `Write` | `file_change` event + evidence with the file's hash |
| `edit_file` | `Edit` | `file_change` event + evidence with the file's hash |
| `glob` | `Glob` | `tool_call` event |
| `grep` | `Grep` | `tool_call` event |
| `record_decision` | — | no hook; goes through `kap decision add` |

File paths are sent absolute. KAP stores them relative to the attempt worktree, and reads the file
itself to hash it — which is why the path must point at a file that exists at hook time.

## Attaching

cocseak connects by itself at startup — the same "it just works" that KAP's Claude Code hooks give,
without a settings file:

| Condition | Result |
| --- | --- |
| inside `.kap/worktrees/<attempt>`, `kap` on `PATH` | records into that attempt |
| `.kap/` repo, no attempt, clean tree | runs `kap attempt start <title> --task <task>` and records in the new worktree |
| `.kap/` repo, uncommitted changes | runs in place, records nothing, explains why (`--kap on` makes it an error) |
| no `.kap/`, or no `kap` binary | quiet no-op (`--kap on` makes it an error) |

Starting an attempt is deliberately skipped for a dirty tree: `kap attempt start` branches from
`HEAD`, so uncommitted work would not be in the worktree. Recording something the agent could not
see would be worse than not recording.

Hook failures never break the run. They are counted in the `kap.failures` field of the JSON result
and printed when `COCSEAK_DEBUG=1` is set. KAP itself behaves the same way: a hook that cannot be
recorded is logged by KAP, not shown to the agent.

## What it looks like

From a run inside a real attempt, against KAP `main`:

```text
$ kap log
17:56:37  command   echo hi from cocseak  exit 0  [subagent: cocseak]
17:56:37  decision  use hooks to record
              why: KAP reads them directly
              instead of: kap import cocseak

$ kap status
  changed files: 0 since base, 0 uncommitted
  decisions: 1
  evidence: 0 observed, 0 reported
```

A run that writes a file adds a `file_change` event and observed evidence:

```text
17:56:51  file_change Write NOTES.md  [subagent: cocseak]
  changed files: 0 since base, 1 uncommitted
  evidence: 1 observed, 0 reported
```

## Known gaps

- **The run row is attributed to `claude-code`.** Per-event `agent_type` is recorded — that is
  where `[subagent: cocseak]` comes from — but KAP creates the run through `run_for_session`,
  whose agent name is the `CLAUDE_CODE` constant. Anything that reads runs rather than events
  sees Claude Code. The fix belongs in KAP: an `--agent` flag on `kap hook`, or `KAP_AGENT`.
- **A failed `bash` has no exit code.** This is Claude Code's shape: success ⇒ exit 0, failure ⇒
  the failure hook, which carries no exit code. cocseak knows the real code and already puts it in
  the session log and the tool output; only the KAP event loses it.
- **Hooks are synchronous.** Each tool call waits for `kap` to finish writing (single-digit
  milliseconds, capped at 5 s). A hung `kap` delays the run but cannot fail it.
- **The final commit includes everything in the worktree.** In an attempt cocseak commits all
  changes, not only the files it touched, because a command may have edited anything. The attempt
  branch is isolated, so this is a proposal rather than a change to the user's branch.
- **`kap hook stop` snapshots the worktree.** That is what makes shell edits evidence, but on a
  large tree it is the most expensive hook in the run.

## Next steps on the KAP side

1. `kap hook --agent cocseak` (or `KAP_AGENT`) so runs and events are attributed correctly.
2. `kap import cocseak` for the session log, mirroring `kap import dsh` — useful when cocseak ran
   outside an attempt, or when the log is collected by a router on another machine.
3. `kap attempt run cocseak --task "..."`, a wrapped-mode adapter that creates the worktree and
   launches the harness in it, so the router does not have to know about KAP at all.
