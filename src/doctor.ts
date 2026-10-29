import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { lookupApiKey, lookupBaseUrl, lookupModel, modelsUrl } from "./config.js";
import { ConfigError } from "./errors.js";
import { findAttempt, findKapBinary, findKapRoot } from "./kap.js";
import { isCleanWorktree } from "./git.js";
import { loadSettings, maskKey } from "./settings.js";

export interface DoctorOptions {
  cwd: string;
  offline: boolean;
}

const CHECK_WIDTH = 11;

/**
 * `cocseak doctor` — answers "is this install ready to run?" before a task is spent on it.
 *
 * It checks the settings that will actually be used, that the workspace exists, whether KAP will
 * record, and (unless --offline) that the provider accepts the key.
 */
export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
  const offline = argv.includes("--offline");
  const unknown = argv.filter((arg) => arg !== "--offline" && arg !== "--help" && arg !== "-h");
  if (unknown.length > 0) {
    process.stderr.write(`cocseak: unknown argument "${unknown[0]}" for doctor\n`);
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: cocseak doctor [--offline]\n\nChecks settings, workspace, KAP, and the provider.\n");
    return 0;
  }

  const lines: string[] = ["cocseak doctor", ""];
  const problems: string[] = [];
  let ready = true;

  const say = (label: string, value: string): void => {
    lines.push(`${`${label}:`.padEnd(CHECK_WIDTH)}${value}`);
  };

  let loaded;
  try {
    loaded = loadSettings();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`cocseak: ${error.message}\n`);
    return 1;
  }

  const model = lookupModel(undefined, loaded.settings);
  const base = lookupBaseUrl(undefined, loaded.settings);
  const key = lookupApiKey(undefined, loaded.settings);

  say("config", loaded.exists ? `${loaded.path}` : `${loaded.path} (missing)`);
  if (!loaded.exists) problems.push("no settings file yet");
  say("model", `${model.value} (${model.source})`);
  say("base", `${base.value} (${base.source})`);
  if (key.value) {
    say("api key", `${maskKey(key.value)} (${key.source})`);
  } else {
    say("api key", "not set");
    ready = false;
    problems.push("no API key: run `cocseak config set api-key <key>` or export DEEPSEEK_API_KEY");
  }

  const cwd = resolve(process.cwd());
  const workspaceOk = existsSync(cwd) && statSync(cwd).isDirectory();
  const git = isGitWorktree(cwd);
  say("workspace", `${cwd}${git ? " (git)" : " (not a git repository)"}`);
  if (workspaceOk && !git) {
    lines.push(
      `${"note:".padEnd(CHECK_WIDTH)}reports will list the files the agent touched, without line counts;` +
        " run `git init` for exact stats",
    );
  }
  if (!workspaceOk) {
    ready = false;
    problems.push(`workspace does not exist: ${cwd}`);
  }

  say("kap", describeKap(cwd));

  if (offline) {
    say("api", "skipped (--offline)");
  } else if (key.value) {
    const result = await checkApi(base.value as string, key.value);
    say("api", result.message);
    if (!result.ok) {
      ready = false;
      problems.push(result.problem);
    }
  } else {
    say("api", "not checked (no key)");
  }

  lines.push("");
  if (ready) {
    lines.push("result:    ready");
    lines.push('next:      cocseak --os --title "first task" --task "say hello"');
  } else {
    lines.push("result:    not ready");
    for (const problem of problems) lines.push(`  - ${problem}`);
    lines.push("next:      fix the items above, then run `cocseak doctor` again");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return ready ? 0 : 1;
}

function describeKap(cwd: string): string {
  const binary = findKapBinary();
  if (!binary) return "not found on PATH (runs will not be recorded)";

  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 2_000 });
  const label = version.status === 0 ? version.stdout.trim() : "kap";

  const attempt = findAttempt(cwd);
  if (attempt) return `${label} — attempt ${attempt} (recording)`;

  const root = findKapRoot(cwd);
  if (!root) return `${label} — not in a KAP repository (set one up with \`kap init\`)`;
  if (!isCleanWorktree(root)) {
    return `${label} — uncommitted changes; a run will not start an attempt (commit or stash first)`;
  }
  return `${label} — no attempt yet; a run will start one automatically`;
}

interface ApiCheck {
  ok: boolean;
  message: string;
  problem: string;
}

async function checkApi(baseUrl: string, apiKey: string): Promise<ApiCheck> {
  const url = modelsUrl(baseUrl);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `HTTP ${response.status} — the key was rejected`,
        problem: "the provider rejected the API key",
      };
    }
    if (response.status === 404 || response.status === 405) {
      return {
        ok: true,
        message: `HTTP ${response.status} — endpoint has no /models (key not verified)`,
        problem: "",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `HTTP ${response.status}`,
        problem: `the provider returned HTTP ${response.status} for ${url}`,
      };
    }

    const body = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(body?.data) ? body.data.length : 0;
    return {
      ok: true,
      message: count > 0 ? `ok — ${count} model(s) available` : "ok",
      problem: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `unreachable — ${message}`,
      problem: `could not reach ${url}: ${message}`,
    };
  }
}

function isGitWorktree(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() === "true";
}
