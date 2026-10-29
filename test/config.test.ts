import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.js";

const base = { maxTurns: undefined, timeoutMs: undefined, briefing: true };

test("uses defaults when nothing is configured", () => {
  const config = resolveConfig(
    { ...base, baseUrl: undefined, apiKey: undefined, model: undefined, settings: { api_key: "k" } },
    {},
  );
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(config.maxTurns, 50);
  assert.equal(config.timeoutMs, 30 * 60 * 1000);
});

test("settings file fills in what flags and env leave empty", () => {
  const config = resolveConfig(
    {
      ...base,
      baseUrl: undefined,
      apiKey: undefined,
      model: undefined,
      settings: { model: "file-model", base_url: "https://file.example/v1", api_key: "k" },
    },
    {},
  );
  assert.equal(config.model, "file-model");
  assert.equal(config.baseUrl, "https://file.example/v1");
  assert.equal(config.apiKey, "k");
});

test("flag beats env beats file", () => {
  const settings = { model: "from-file", base_url: "https://file.example/v1", api_key: "file-key" };

  const fromFile = resolveConfig(
    { ...base, baseUrl: undefined, apiKey: undefined, model: undefined, settings },
    {},
  );
  assert.equal(fromFile.model, "from-file");
  assert.equal(fromFile.baseUrl, "https://file.example/v1");
  assert.equal(fromFile.apiKey, "file-key");

  const fromEnv = resolveConfig(
    { ...base, baseUrl: undefined, apiKey: undefined, model: undefined, settings },
    { DEEPSEEK_MODEL: "from-env", DEEPSEEK_API_KEY: "env-key" },
  );
  assert.equal(fromEnv.model, "from-env");
  assert.equal(fromEnv.apiKey, "env-key");
  assert.equal(fromEnv.baseUrl, "https://file.example/v1");

  const fromFlag = resolveConfig(
    {
      ...base,
      baseUrl: "https://flag.example/v1",
      apiKey: "flag-key",
      model: "from-flag",
      settings,
    },
    { DEEPSEEK_MODEL: "from-env", DEEPSEEK_API_KEY: "env-key" },
  );
  assert.equal(fromFlag.model, "from-flag");
  assert.equal(fromFlag.apiKey, "flag-key");
  assert.equal(fromFlag.baseUrl, "https://flag.example/v1");
});

test("the timeout in the settings file is seconds", () => {
  const config = resolveConfig(
    {
      ...base,
      baseUrl: undefined,
      apiKey: undefined,
      model: undefined,
      settings: { api_key: "k", timeout_seconds: 90, max_turns: 7 },
    },
    {},
  );
  assert.equal(config.timeoutMs, 90_000);
  assert.equal(config.maxTurns, 7);
});

test("the missing-key error says how to fix it", () => {
  assert.throws(
    () =>
      resolveConfig(
        { ...base, baseUrl: undefined, apiKey: undefined, model: undefined, settings: {} },
        {},
      ),
    /cocseak config set api-key/,
  );
});

test("the context window follows the model, and an explicit setting wins", () => {
  const input = { ...base, baseUrl: undefined, apiKey: undefined, contextTokens: undefined };
  const flash = resolveConfig({ ...input, model: "deepseek-flash", settings: { api_key: "k" } }, {});
  assert.equal(flash.contextTokens, 1_000_000);

  const chat = resolveConfig({ ...input, model: "deepseek-chat", settings: { api_key: "k" } }, {});
  assert.equal(chat.contextTokens, 128_000);

  const saved = resolveConfig(
    { ...input, model: "deepseek-flash", settings: { api_key: "k", context_tokens: 200_000 } },
    {},
  );
  assert.equal(saved.contextTokens, 200_000);

  const fromEnv = resolveConfig(
    { ...input, model: "deepseek-flash", settings: { api_key: "k", context_tokens: 200_000 } },
    { COCSEAK_CONTEXT_TOKENS: "500000" },
  );
  assert.equal(fromEnv.contextTokens, 500_000);

  const fromFlag = resolveConfig(
    { ...input, model: "deepseek-flash", contextTokens: 64_000, settings: { api_key: "k" } },
    { COCSEAK_CONTEXT_TOKENS: "500000" },
  );
  assert.equal(fromFlag.contextTokens, 64_000);
});

test("the turn budget follows the model, and an explicit setting wins", () => {
  const input = { ...base, baseUrl: undefined, apiKey: undefined, contextTokens: undefined };
  const flash = resolveConfig({ ...input, model: "deepseek-flash", settings: { api_key: "k" } }, {});
  assert.equal(flash.maxTurns, 100);
  const chat = resolveConfig({ ...input, model: "deepseek-chat", settings: { api_key: "k" } }, {});
  assert.equal(chat.maxTurns, 50);
  const saved = resolveConfig(
    { ...input, model: "deepseek-flash", settings: { api_key: "k", max_turns: 30 } },
    {},
  );
  assert.equal(saved.maxTurns, 30);
  const flag = resolveConfig({ ...input, maxTurns: 7, model: "deepseek-flash", settings: { api_key: "k" } }, {});
  assert.equal(flag.maxTurns, 7);
});
