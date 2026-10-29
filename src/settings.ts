import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigError } from "./errors.js";

/** Persisted in `~/.cocseak/config.json`. Every field is optional. */
export interface Settings {
  model?: string;
  base_url?: string;
  api_key?: string;
  max_turns?: number;
  timeout_seconds?: number;
}

export type SettingName = "model" | "base-url" | "api-key" | "max-turns" | "timeout";

export const SETTING_NAMES: readonly SettingName[] = [
  "model",
  "base-url",
  "api-key",
  "max-turns",
  "timeout",
];

export function cocseakHome(): string {
  return process.env.COCSEAK_HOME?.trim() || join(homedir(), ".cocseak");
}

export function settingsPath(): string {
  return join(cocseakHome(), "config.json");
}

export interface LoadedSettings {
  settings: Settings;
  exists: boolean;
  path: string;
}

export function loadSettings(path = settingsPath()): LoadedSettings {
  if (!existsSync(path)) return { settings: {}, exists: false, path };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`could not read ${path}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} is not valid JSON. Fix it or delete it and run \`cocseak config set\`.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }

  return { settings: normalize(parsed as Record<string, unknown>), exists: true, path };
}

export function saveSettings(settings: Settings, path = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems do not support chmod; the key is not worse than the umask allowed.
  }
}

export function setSetting(settings: Settings, name: SettingName, raw: string): Settings {
  const value = raw.trim();
  if (value === "") throw new ConfigError(`the value for ${name} is empty`);

  switch (name) {
    case "model":
      return { ...settings, model: value };
    case "api-key":
      if (/\s/.test(value)) throw new ConfigError("an API key must not contain whitespace");
      return { ...settings, api_key: value };
    case "base-url": {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new ConfigError(`base-url is not a URL: ${value}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ConfigError("base-url must start with http:// or https://");
      }
      return { ...settings, base_url: value.replace(/\/+$/, "") };
    }
    case "max-turns": {
      const turns = Number(value);
      if (!Number.isInteger(turns) || turns <= 0) throw new ConfigError("max-turns must be a positive integer");
      return { ...settings, max_turns: turns };
    }
    case "timeout": {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds <= 0) throw new ConfigError("timeout must be a positive number of seconds");
      return { ...settings, timeout_seconds: seconds };
    }
  }
}

export function unsetSetting(settings: Settings, name: SettingName): Settings {
  const next = { ...settings };
  if (name === "model") delete next.model;
  if (name === "base-url") delete next.base_url;
  if (name === "api-key") delete next.api_key;
  if (name === "max-turns") delete next.max_turns;
  if (name === "timeout") delete next.timeout_seconds;
  return next;
}

/** Never print a key in full. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function normalize(raw: Record<string, unknown>): Settings {
  const settings: Settings = {};
  if (typeof raw.model === "string" && raw.model.trim() !== "") settings.model = raw.model.trim();
  if (typeof raw.base_url === "string" && raw.base_url.trim() !== "") {
    settings.base_url = raw.base_url.trim().replace(/\/+$/, "");
  }
  if (typeof raw.api_key === "string" && raw.api_key.trim() !== "") settings.api_key = raw.api_key.trim();
  if (typeof raw.max_turns === "number" && Number.isInteger(raw.max_turns) && raw.max_turns > 0) {
    settings.max_turns = raw.max_turns;
  }
  if (
    typeof raw.timeout_seconds === "number" &&
    Number.isInteger(raw.timeout_seconds) &&
    raw.timeout_seconds > 0
  ) {
    settings.timeout_seconds = raw.timeout_seconds;
  }
  return settings;
}
