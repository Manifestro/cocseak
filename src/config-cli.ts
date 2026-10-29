import { maskKey, loadSettings, saveSettings, setSetting, settingsPath, unsetSetting, SETTING_NAMES, type SettingName } from "./settings.js";
import { lookupApiKey, lookupBaseUrl, lookupContextTokens, lookupMaxTurns, lookupModel } from "./config.js";
import { ConfigError, UsageError } from "./errors.js";

const SET_USAGE = `cocseak config set <name> <value>

Names:
  model       model id, e.g. deepseek-chat
  base-url    OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1
  api-key     API key (stored in the settings file, chmod 600)
  max-turns   model turns before a run fails
  timeout     wall-clock limit in seconds
  context-tokens  model context window (compaction happens at 75%)
`;

/** `cocseak config [show|path|set|unset]` — the first thing a new install needs. */
export function runConfigCommand(argv: readonly string[]): number {
  try {
    const sub = argv[0];
    if (sub === undefined || sub === "show") return show();
    if (sub === "path") {
      process.stdout.write(`${settingsPath()}\n`);
      return 0;
    }
    if (sub === "set") return set(argv[1], argv.slice(2));
    if (sub === "unset") return unset(argv[1]);
    throw new UsageError(`unknown config command "${sub}"\n\n${SET_USAGE}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cocseak: ${message}\n`);
    return error instanceof UsageError || error instanceof ConfigError ? 2 : 1;
  }
}

function show(): number {
  const loaded = loadSettings();
  const model = lookupModel(undefined, loaded.settings);
  const base = lookupBaseUrl(undefined, loaded.settings);
  const key = lookupApiKey(undefined, loaded.settings);
  const context = lookupContextTokens(undefined, model.value as string, loaded.settings);
  const turns = lookupMaxTurns(undefined, model.value as string, loaded.settings);

  process.stdout.write(`config:  ${loaded.path} (${loaded.exists ? "exists" : "missing"})\n`);
  process.stdout.write(`model:   ${model.value} (${model.source})\n`);
  process.stdout.write(`base:    ${base.value} (${base.source})\n`);
  process.stdout.write(`context: ${context.value.toLocaleString("en-US")} tokens (${context.source})\n`);
  process.stdout.write(`turns:   ${turns.value} (${turns.source})\n`);
  process.stdout.write(
    `api key: ${key.value ? `${maskKey(key.value)} (${key.source})` : "not set"}\n`,
  );

  if (!loaded.exists) {
    process.stdout.write("\nNothing saved yet. Start with:\n  cocseak config set api-key <key>\n");
  }
  return 0;
}

function set(name: string | undefined, value: string[]): number {
  if (name === undefined) throw new UsageError(SET_USAGE);
  const setting = requireName(name);
  if (value.length === 0) throw new UsageError(`missing value for ${setting}\n\n${SET_USAGE}`);

  const loaded = loadSettings();
  const next = setSetting(loaded.settings, setting, value.join(" "));
  saveSettings(next, loaded.path);

  const shown = setting === "api-key" ? maskKey(next.api_key as string) : (value.join(" ").trim());
  process.stdout.write(`set ${setting} = ${shown}\n`);
  process.stdout.write(`saved to ${loaded.path}\n`);
  return 0;
}

function unset(name: string | undefined): number {
  if (name === undefined) throw new UsageError(SET_USAGE);
  const setting = requireName(name);
  const loaded = loadSettings();
  saveSettings(unsetSetting(loaded.settings, setting), loaded.path);
  process.stdout.write(`unset ${setting}\n`);
  return 0;
}

function requireName(name: string): SettingName {
  if ((SETTING_NAMES as readonly string[]).includes(name)) return name as SettingName;
  throw new UsageError(`unknown setting "${name}"\n\n${SET_USAGE}`);
}
