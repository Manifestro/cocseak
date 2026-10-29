import { parseArgs } from "node:util";

import { UsageError } from "./errors.js";

export interface CliOptions {
  /** One-shot mode. Required for now: cocseak has no interactive UI by design. */
  oneShot: boolean;
  title: string | undefined;
  task: string | undefined;
  taskFile: string | undefined;
  cwd: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  maxTurns: number | undefined;
  timeoutMs: number | undefined;
  json: boolean;
  quiet: boolean;
  answerOnly: boolean;
  reportPath: string | undefined;
  kap: "auto" | "on" | "off";
  init: boolean;
  briefing: boolean;
  help: boolean;
  version: boolean;
}

export const USAGE = `cocseak — one-shot coding harness for OpenAI-compatible models

Usage:
  cocseak --os --title <title> --task <task> [options]
  cocseak --os --title <title> --task-file <path> [options]

Required:
  --os                 Run one shot and exit. This is the only mode in this version.
  --task <text>        What to do. Must not be empty.

Options:
  --title <text>       Label for the run. Empty is allowed. Defaults to the directory name.
  --task-file <path>   Read the task from a file instead of --task.
  --cwd <path>         Workspace the agent may read and write. Defaults to the process cwd.
  --model <id>         Model id. Default: $COCSEAK_MODEL, $DEEPSEEK_MODEL, or deepseek-chat.
  --base-url <url>     OpenAI-compatible base URL. Default: $COCSEAK_BASE_URL,
                       $DEEPSEEK_BASE_URL, or https://api.deepseek.com/v1.
  --api-key <key>      API key. Default: $COCSEAK_API_KEY or $DEEPSEEK_API_KEY.
  --max-turns <n>      Model turns before the run fails. Default: 50.
  --timeout <sec>      Wall-clock limit for the whole run. Default: 1800.
  --json               Print the report as one JSON object on stdout.
  --answer-only        Print only the final answer, without the report header.
  --report <path>      Also write the report to a file (JSON, or Markdown if the name ends .md).
  --quiet              Do not print progress to stderr.
  --kap <mode>         KAP adapter: auto | on | off. Default: auto.
  --no-init            Do not create git or .kap automatically; fail instead.
  --no-briefing        Do not ask KAP for the attempt briefing at startup.
  --help, -h           Show this help.
  --version, -v        Print the version.

Commands:
  config [show|path|set|unset]   Show or change settings: model, base-url, api-key,
                                 max-turns, timeout.
  doctor [--offline]             Check settings, workspace, KAP, and the provider.
  help                           This text.

Settings live in ~/.cocseak/config.json (override the directory with COCSEAK_HOME).
Flags > environment > settings file > defaults.

Exit codes:
  0  the task finished
  1  the run failed (provider, tool, or internal error)
  2  usage or configuration error
  3  timeout
  4  max turns reached
`;

/** Parse and validate argv. Throws UsageError for anything the user can fix. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        os: { type: "boolean" },
        title: { type: "string" },
        task: { type: "string" },
        "task-file": { type: "string" },
        cwd: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "api-key": { type: "string" },
        "max-turns": { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        "answer-only": { type: "boolean" },
        report: { type: "string" },
        kap: { type: "string" },
        "no-init": { type: "boolean" },
        "no-briefing": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values;
  const kap = values.kap ?? "auto";
  if (kap !== "auto" && kap !== "on" && kap !== "off") {
    throw new UsageError(`--kap must be one of auto, on, off (got "${kap}")`);
  }

  if (values.task !== undefined && values["task-file"] !== undefined) {
    throw new UsageError("--task and --task-file are mutually exclusive");
  }

  return {
    oneShot: values.os === true,
    title: values.title,
    task: values.task,
    taskFile: values["task-file"],
    cwd: values.cwd,
    model: values.model,
    baseUrl: values["base-url"],
    apiKey: values["api-key"],
    maxTurns: parsePositiveInt(values["max-turns"], "--max-turns"),
    timeoutMs: parseTimeout(values.timeout),
    json: values.json === true,
    quiet: values.quiet === true,
    answerOnly: values["answer-only"] === true,
    reportPath: values.report,
    kap,
    init: values["no-init"] !== true,
    briefing: values["no-briefing"] !== true,
    help: values.help === true,
    version: values.version === true,
  };
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} expects a positive integer, got "${raw}"`);
  const value = Number.parseInt(raw, 10);
  if (value <= 0) throw new UsageError(`${flag} must be greater than zero`);
  return value;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--timeout expects seconds, got "${raw}"`);
  const seconds = Number.parseInt(raw, 10);
  if (seconds <= 0) throw new UsageError("--timeout must be greater than zero");
  return seconds * 1000;
}
