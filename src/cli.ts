import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runAgent } from "./agent.js";
import { parseCliArgs, USAGE, type CliOptions } from "./args.js";
import { resolveConfig } from "./config.js";
import { ConfigError, MaxTurnsError, ProviderError, TimeoutError, UsageError } from "./errors.js";
import { KapAdapter } from "./kap.js";
import {
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_MAX_TURNS,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  type FailureReport,
  type SuccessReport,
} from "./output.js";
import { buildSystemPrompt } from "./prompt.js";
import { OpenAiCompatibleProvider } from "./provider.js";
import { newRunId, SessionLog } from "./session.js";
import { TOOLS } from "./tools/index.js";
import { VERSION } from "./version.js";

export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    return fail(error, "usage", [], null);
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
  let interrupted = false;

  try {
    if (!options.oneShot) {
      throw new UsageError("cocseak has no interactive mode: pass --os and a --task");
    }

    const cwd = resolve(options.cwd ?? process.cwd());
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new UsageError(`--cwd does not exist or is not a directory: ${cwd}`);
    }

    const task = readTask(options);
    if (task.trim() === "") throw new UsageError("the task is empty");

    const config = resolveConfig({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
      briefing: options.briefing,
    });

    const title = options.title ?? basename(cwd);
    const runId = newRunId();
    session = new SessionLog(sessionDirectory(cwd, runId), runId);

    const debug = (message: string): void => {
      if (process.env.COCSEAK_DEBUG) process.stderr.write(`cocseak: ${message}\n`);
    };

    kap = KapAdapter.detect({ cwd, mode: options.kap, runId, debug });
    if (kap.state.active) {
      say(`kap: recording attempt ${kap.state.attempt} (${kap.state.root})`);
    } else {
      debug(`kap: not recording — ${kap.state.reason}`);
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
      const report: SuccessReport = {
        ok: true,
        version: VERSION,
        title,
        model: config.model,
        cwd,
        answer: result.answer,
        turns: result.turns,
        usage: result.usage,
        duration_ms: Date.now() - startedAt,
        session: session.path,
        kap: kap.describe(),
      };

      if (json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        process.stdout.write(`${result.answer}\n`);
      }
      return EXIT_OK;
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
  } catch (error) {
    if (interrupted) {
      if (json) {
        const report: FailureReport = {
          ok: false,
          version: VERSION,
          error: { kind: "interrupted", message: "interrupted" },
          session: session?.path ?? null,
        };
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        process.stderr.write("cocseak: interrupted\n");
      }
      return EXIT_INTERRUPTED;
    }
    return fail(error, classify(error), [], session, json);
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

function fail(
  error: unknown,
  kind: FailureReport["error"]["kind"],
  _argv: readonly string[],
  session: SessionLog | null,
  json = false,
): number {
  const message = error instanceof Error ? error.message : String(error);

  if (json) {
    const report: FailureReport = {
      ok: false,
      version: VERSION,
      error: { kind, message },
      session: session?.path ?? null,
    };
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

function readTask(options: CliOptions): string {
  if (options.taskFile !== undefined) {
    try {
      return readFileSync(resolve(options.taskFile), "utf8");
    } catch (error) {
      throw new UsageError(`could not read --task-file: ${(error as Error).message}`);
    }
  }
  if (options.task === undefined) {
    throw new UsageError("missing --task (or --task-file)");
  }
  return options.task;
}

function sessionDirectory(cwd: string, runId: string): string {
  const home = process.env.COCSEAK_HOME?.trim() || join(homedir(), ".cocseak");
  const slug =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
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
