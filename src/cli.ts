import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runAgent } from "./agent.js";
import { parseCliArgs, USAGE, type CliOptions } from "./args.js";
import { resolveConfig } from "./config.js";
import { ConfigError, MaxTurnsError, ProviderError, TimeoutError, UsageError } from "./errors.js";
import { captureBaseline, collectChanges, commitAll, readHead } from "./git.js";
import { runConfigCommand } from "./config-cli.js";
import { runDoctorCommand } from "./doctor.js";
import { attachKap } from "./kap-attach.js";
import type { KapAdapter } from "./kap.js";
import {
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_MAX_TURNS,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_USAGE,
} from "./output.js";
import { buildSystemPrompt } from "./prompt.js";
import { OpenAiCompatibleProvider } from "./provider.js";
import {
  buildFailureReport,
  buildReport,
  renderMarkdown,
  renderText,
  type FailureReport,
} from "./report.js";
import { newRunId, SessionLog } from "./session.js";
import { loadSettings, settingsPath } from "./settings.js";
import { resolveTask } from "./task.js";
import { TOOLS } from "./tools/index.js";
import { VERSION } from "./version.js";

export async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];
  if (first === "config") return runConfigCommand(argv.slice(1));
  if (first === "doctor") return runDoctorCommand(argv.slice(1));
  if (first === "help") {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (first === undefined) {
    printWelcome();
    return EXIT_OK;
  }

  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    return fail(error, "usage", null, argv.includes("--json"));
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }

  const json = options.json;
  const quiet = options.quiet;
  const say = (message: string): void => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };

  let session: SessionLog | null = null;
  let kap: KapAdapter | null = null;
  let title = "";
  let model = "";
  let cwd = process.cwd();
  let interrupted = false;

  try {
    if (!options.oneShot) {
      throw new UsageError("cocseak has no interactive mode: pass --os and a --task");
    }

    const requestedCwd = resolve(options.cwd ?? process.cwd());
    if (!existsSync(requestedCwd) || !statSync(requestedCwd).isDirectory()) {
      throw new UsageError(`--cwd does not exist or is not a directory: ${requestedCwd}`);
    }
    cwd = requestedCwd;

    const task = resolveTask(options, readStdinIfRequested(options));
    if (task.trim() === "") throw new UsageError("the task is empty");

    const loadedSettings = loadSettings();
    const config = resolveConfig({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
      briefing: options.briefing,
      settings: loadedSettings.settings,
    });
    model = config.model;

    title = options.title ?? basename(requestedCwd);
    const runId = newRunId();
    session = new SessionLog(sessionDirectory(requestedCwd, runId), runId);

    const debug = (message: string): void => {
      if (process.env.COCSEAK_DEBUG) process.stderr.write(`cocseak: ${message}\n`);
    };

    // KAP attaches itself: in an attempt it records, in a clean KAP repository it starts one.
    const attached = attachKap({
      cwd: requestedCwd,
      mode: options.kap,
      runId,
      task,
      title,
      init: options.init,
      debug,
    });
    cwd = attached.workspace;
    kap = attached.adapter;
    for (const note of attached.notes) say(`kap: ${note}`);
    if (attached.created) {
      say(`kap: created attempt ${attached.created.attempt} on ${attached.created.branch}`);
      say(`kap: working in ${attached.created.worktree}`);
      say(`kap: review with \`kap review ${attached.created.attempt}\`, merge with \`kap merge ${attached.created.attempt}\``);
    } else if (kap.state.active) {
      say(`kap: recording attempt ${kap.state.attempt} (${kap.state.root})`);
    } else {
      debug(`kap: not recording — ${kap.state.reason}`);
      if (attached.note) say(`kap: ${attached.note}`);
    }

    const briefing = config.briefing ? await kap.sessionStart() : null;
    if (briefing) say("kap: loaded the attempt briefing");

    const provider = new OpenAiCompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });

    const systemPrompt = buildSystemPrompt({
      cwd,
      briefing,
      kapAttempt: kap.state.attempt,
      toolNames: TOOLS.map((tool) => tool.name),
    });

    const baseline = captureBaseline(cwd);
    const baseCommit = readHead(cwd);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    timer.unref();

    const onInterrupt = (): void => {
      interrupted = true;
      controller.abort();
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    const startedAt = Date.now();
    say(`cocseak: ${title} · ${config.model} · ${cwd}`);

    try {
      const result = await runAgent({
        provider,
        tools: TOOLS,
        systemPrompt,
        task,
        cwd,
        title,
        maxTurns: config.maxTurns,
        signal: controller.signal,
        session,
        kap,
        onEvent: (event) => {
          if (quiet) return;
          if (event.type === "turn") process.stderr.write(`\nturn ${event.turn}\n`);
          if (event.type === "tool_start") {
            process.stderr.write(`→ ${event.name}: ${oneliner(event.args, 200)}\n`);
          }
          if (event.type === "tool_end" && event.isError) {
            process.stderr.write(`  ✗ ${oneliner(event.output, 300)}\n`);
          }
        },
      });

      await session.flush();

      const changes = collectChanges(cwd, result.changed, baseline, baseCommit);
      let commit: string | null = null;
      if (options.commit && kap.state.active) {
        const committed = commitAll(cwd, `cocseak: ${title}`);
        if (committed.committed) {
          commit = committed.hash;
          say(`git: committed ${committed.hash} on ${kap.state.attempt}`);
        }
      }

      const report = buildReport({
        title,
        task,
        model: config.model,
        cwd,
        answer: result.answer,
        turns: result.turns,
        usage: result.usage,
        duration_ms: Date.now() - startedAt,
        session: session.path,
        kap: {
          ...kap.describe(),
          ...(attached.created
            ? { created: true, branch: attached.created.branch, worktree: attached.created.worktree }
            : {}),
        },
        changes,
        commit,
        commands: result.commands,
        decisions: result.decisions,
      });

      if (options.reportPath !== undefined) writeReport(options.reportPath, report);
      if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
      else if (options.answerOnly) process.stdout.write(`${report.answer}\n`);
      else process.stdout.write(renderText(report));

      return EXIT_OK;
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
  } catch (error) {
    if (interrupted) {
      if (json) {
        const report: FailureReport = buildFailureReport({
          title,
          model,
          cwd,
          session: session?.path ?? null,
          kind: "interrupted",
          message: "interrupted",
        });
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        process.stderr.write("cocseak: interrupted\n");
      }
      return EXIT_INTERRUPTED;
    }
    return fail(error, classify(error), { title, model, cwd, session }, json);
  }
}

function printWelcome(): void {
  process.stdout.write(
    `cocseak ${VERSION} — one-shot coding harness for OpenAI-compatible models\n\n` +
      "First run:\n" +
      "  cocseak config set api-key <key>     store the key (or export DEEPSEEK_API_KEY)\n" +
      "  cocseak doctor                       check settings, workspace, API, and KAP\n" +
      "  cocseak --os --title \"hello\" --task \"say hello\"\n\n" +
      `Settings: ${settingsPath()}\n` +
      "All flags: cocseak --help\n",
  );
}

function readStdinIfRequested(options: CliOptions): string {
  const wantsStdin = options.task === "-" || options.taskFile === "-";
  if (!wantsStdin) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function classify(error: unknown): FailureReport["error"]["kind"] {
  if (error instanceof UsageError) return "usage";
  if (error instanceof ConfigError) return "config";
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof MaxTurnsError) return "max_turns";
  if (error instanceof ProviderError) return "provider";
  return "internal";
}

interface Context {
  title: string;
  model: string;
  cwd: string;
  session: SessionLog | null;
}

function fail(
  error: unknown,
  kind: FailureReport["error"]["kind"],
  context: Context | null,
  json: boolean,
): number {
  const message = error instanceof Error ? error.message : String(error);

  if (json) {
    const report: FailureReport = buildFailureReport({
      title: context?.title ?? "",
      model: context?.model ?? "",
      cwd: context?.cwd ?? process.cwd(),
      session: context?.session?.path ?? null,
      kind,
      message,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (kind === "usage") {
    process.stderr.write(`cocseak: ${message}\n\n${USAGE}`);
  } else {
    process.stderr.write(`cocseak: ${message}\n`);
  }

  if (kind === "usage" || kind === "config") return EXIT_USAGE;
  if (kind === "timeout") return EXIT_TIMEOUT;
  if (kind === "max_turns") return EXIT_MAX_TURNS;
  return EXIT_FAILURE;
}

function writeReport(path: string, report: ReturnType<typeof buildReport>): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const markdown = /\.(md|markdown)$/i.test(absolute);
  writeFileSync(absolute, markdown ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function sessionDirectory(cwd: string, runId: string): string {
  const home = process.env.COCSEAK_HOME?.trim() || join(homedir(), ".cocseak");
  const slug =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return join(home, "sessions", `${slug}-${hash}`, runId);
}

function oneliner(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

// `node src/cli.ts ...` and `tsx src/cli.ts ...` behave like the installed binary.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
