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
