import { ConfigError } from "./errors.js";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  briefing: boolean;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_MAX_TURNS = 50;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ConfigInput {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  maxTurns: number | undefined;
  timeoutMs: number | undefined;
  briefing: boolean;
}

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function resolveConfig(input: ConfigInput, env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = firstSet(
    input.baseUrl,
    env.COCSEAK_BASE_URL,
    env.DEEPSEEK_BASE_URL,
    DEFAULT_BASE_URL,
  ) as string;

  const apiKey = firstSet(input.apiKey, env.COCSEAK_API_KEY, env.DEEPSEEK_API_KEY);
  if (!apiKey) {
    throw new ConfigError(
      "No API key. Pass --api-key or set COCSEAK_API_KEY / DEEPSEEK_API_KEY.",
    );
  }

  const model = firstSet(input.model, env.COCSEAK_MODEL, env.DEEPSEEK_MODEL, DEFAULT_MODEL) as string;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    briefing: input.briefing,
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}
