import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError } from "../src/errors.js";
import {
  loadSettings,
  maskKey,
  saveSettings,
  setSetting,
  settingsPath,
  unsetSetting,
} from "../src/settings.js";
import { tempDir } from "./helpers.js";

function withHome<T>(directory: string, body: () => T): T {
  const previous = process.env.COCSEAK_HOME;
  process.env.COCSEAK_HOME = directory;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.COCSEAK_HOME;
    else process.env.COCSEAK_HOME = previous;
  }
}

test("round-trips settings through a 0600 file", () => {
  const dir = tempDir();
  try {
    withHome(dir.path, () => {
      assert.equal(loadSettings().exists, false);

      saveSettings({ api_key: "sk-test-1234", model: "deepseek-chat" });
      const path = settingsPath();
      assert.equal(path, join(dir.path, "config.json"));
      assert.equal((statSync(path).mode & 0o777).toString(8), "600");

      const loaded = loadSettings();
      assert.equal(loaded.exists, true);
      assert.equal(loaded.settings.api_key, "sk-test-1234");
      assert.equal(loaded.settings.model, "deepseek-chat");
      assert.match(readFileSync(path, "utf8"), /sk-test-1234/);
    });
  } finally {
    dir.cleanup();
  }
});

test("reports broken JSON instead of guessing", () => {
  const dir = tempDir();
  try {
    withHome(dir.path, () => {
      writeFileSync(join(dir.path, "config.json"), "{not json");
      assert.throws(() => loadSettings(), ConfigError);
    });
  } finally {
    dir.cleanup();
  }
});

test("validates values as they are set", () => {
  assert.throws(() => setSetting({}, "base-url", "not a url"), /not a URL/);
  assert.throws(() => setSetting({}, "base-url", "ftp://example.com"), /http/);
  assert.throws(() => setSetting({}, "api-key", "has space"), /whitespace/);
  assert.throws(() => setSetting({}, "max-turns", "0"), /positive/);
  assert.throws(() => setSetting({}, "timeout", "abc"), /positive/);

  assert.deepEqual(setSetting({}, "base-url", "https://api.example.com/v1/"), {
    base_url: "https://api.example.com/v1",
  });
  assert.deepEqual(unsetSetting({ model: "a", api_key: "b" }, "model"), { api_key: "b" });
});

test("never prints a full key", () => {
  assert.equal(maskKey("sk-1234567890abcdef"), "sk-…cdef");
  assert.equal(maskKey("short"), "••••");
});
