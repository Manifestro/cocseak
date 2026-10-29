# Release checklist

Run this before tagging. Every item is a command you can copy.

## 1. Static checks and tests

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 2. Package and install as a user would

```sh
npm pack --pack-destination /tmp
npm install -g /tmp/cocseak-<version>.tgz --prefix /tmp/rel-prefix
/tmp/rel-prefix/bin/cocseak --version
COCSEAK_HOME=/tmp/rel-home /tmp/rel-prefix/bin/cocseak doctor --offline
```

`doctor` must exit 1 with "no API key", and exit 0 after
`config set api-key ...`.

## 3. Real provider, real KAP

```sh
mkdir /tmp/rel && cd /tmp/rel
printf '# x\n' > README.md
COCSEAK_HOME=/tmp/rel-home cocseak --os --title "release" \
  --task "Create NOTES.md containing: hello"
```

Expect: git initialised, baseline commit, `kap init`, attempt created, worktree used, and at the end
`git: committed <hash> on <attempt>`.

```sh
kap review <attempt> --approve
kap merge <attempt>
ls                       # NOTES.md is now in the main checkout
```

## 4. Failure paths

| case | expected |
| --- | --- |
| `cocseak --os` | exit 2, "missing --task" |
| unknown flag | exit 2 |
| provider 401 | exit 1, HTTP 401 in the message |
| hanging provider + `--timeout 2` | exit 3 after ~2 s |
| `kill -INT` during a run | exit 130, "interrupted" |
| KAP repository with uncommitted tracked changes | exit 2, "will not edit the main checkout unrecorded" |
| git repository with history, no `.kap` | runs unrecorded, note says to run `kap init`; no commit made |
| `--kap on` without KAP | exit 2, clear error |

## 5. Version

Bump `package.json` and `src/version.ts` together; `cocseak --version` must match the tarball name.

## Known limitations

- macOS/Linux only; the agent runs `sh`, not PowerShell.
- No session resume yet: every run starts cold.
- Tools run sequentially; no parallel tool calls.
- Provider retries are bounded: three attempts, then the run fails.
- Context is compacted at 75% of `--context-tokens`; each compaction costs one extra model call.
- Workspace confinement is path-based (symlinks are resolved and refused), but `bash` is not a
  sandbox: it can do anything the user can.
- A KAP repository with uncommitted tracked changes is refused; commit or stash first, or `--kap off`.
- `glob` and `grep` skip symlinks, so KAP's shared links (`data/`) are not searched; `read_file`
  reads through them and `bash` sees them, but nothing writes through them.
