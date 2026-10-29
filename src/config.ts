import type { Settings } from "./settings.js";
import { ConfigError } from "./errors.js";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  contextTokens: number;
  briefing: boolean;
}

export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_MODEL = "deepseek-chat";
export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CONTEXT_TOKENS = 128_000;

/**
 * Context windows of models whose window differs from the default. The window decides when older
 * steps are summarized (at 75%), so a model with a 1M window treated as 128k would be compacted
 * long before it needs to be. Anything not listed gets the default; `context-tokens` overrides.
 */
export const MODEL_CONTEXT_TOKENS: Readonly<Record<string, number>> = {
  "deepseek-flash": 1_000_000,
};

export interface ConfigInput {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  maxTurns: number | undefined;
  timeoutMs: number | undefined;
  contextTokens: number | undefined;
  briefing: boolean;
  settings?: Settings;
}

export interface SettingValue {
  value: string | undefined;
  source: "flag" | "env" | "config" | "default" | "missing";
}

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export interface ContextValue {
  value: number;
  source: "flag" | "env" | "config" | "model" | "default";
}

/** The context window to plan for: flag, env, settings, the model's known window, the default. */
export function lookupContextTokens(
  flag: number | undefined,
  model: string,
  settings: Settings,
  env = process.env,
): ContextValue {
  if (flag !== undefined) return { value: flag, source: "flag" };
  const fromEnv = Number(env.COCSEAK_CONTEXT_TOKENS);
  if (env.COCSEAK_CONTEXT_TOKENS && Number.isInteger(fromEnv) && fromEnv > 0) {
    return { value: fromEnv, source: "env" };
  }
  if (settings.context_tokens !== undefined) return { value: settings.context_tokens, source: "config" };
  const known = MODEL_CONTEXT_TOKENS[model];
  if (known !== undefined) return { value: known, source: "model" };
  return { value: DEFAULT_CONTEXT_TOKENS, source: "default" };
}

export function lookupModel(flag: string | undefined, settings: Settings, env = process.env): SettingValue {
  const value = firstSet(flag, env.COCSEAK_MODEL, env.DEEPSEEK_MODEL, settings.model);
  if (value !== undefined) {
    return { value, source: flag ? "flag" : env.COCSEAK_MODEL || env.DEEPSEEK_MODEL ? "env" : "config" };
  }
  return { value: DEFAULT_MODEL, source: "default" };
}

export function lookupBaseUrl(flag: string | undefined, settings: Settings, env = process.env): SettingValue {
  const value = firstSet(flag, env.COCSEAK_BASE_URL, env.DEEPSEEK_BASE_URL, settings.base_url);
  if (value !== undefined) {
    return { value, source: flag ? "flag" : env.COCSEAK_BASE_URL || env.DEEPSEEK_BASE_URL ? "env" : "config" };
  }
  return { value: DEFAULT_BASE_URL, source: "default" };
}

export function lookupApiKey(flag: string | undefined, settings: Settings, env = process.env): SettingValue {
  const value = firstSet(flag, env.COCSEAK_API_KEY, env.DEEPSEEK_API_KEY, settings.api_key);
  if (value !== undefined) {
    return { value, source: flag ? "flag" : env.COCSEAK_API_KEY || env.DEEPSEEK_API_KEY ? "env" : "config" };
  }
  return { value: undefined, source: "missing" };
}

export function resolveConfig(input: ConfigInput, env: NodeJS.ProcessEnv = process.env): Config {
  const settings = input.settings ?? {};
  const baseUrl = lookupBaseUrl(input.baseUrl, settings, env).value as string;
  const model = lookupModel(input.model, settings, env).value as string;
  const apiKey = lookupApiKey(input.apiKey, settings, env).value;

  if (!apiKey) {
    throw new ConfigError(
      "No API key found. Set one up with:\n" +
        "  cocseak config set api-key <key>\n" +
        "or export COCSEAK_API_KEY / DEEPSEEK_API_KEY.",
    );
  }

  const maxTurns = input.maxTurns ?? settings.max_turns ?? DEFAULT_MAX_TURNS;
  // A file-level timeout is stored in seconds, a flag-level one already in milliseconds.
  const timeoutMs =
    input.timeoutMs ??
    (settings.timeout_seconds !== undefined ? settings.timeout_seconds * 1000 : DEFAULT_TIMEOUT_MS);
  const contextTokens = lookupContextTokens(input.contextTokens, model, settings, env).value;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    maxTurns,
    timeoutMs,
    contextTokens,
    briefing: input.briefing,
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}
