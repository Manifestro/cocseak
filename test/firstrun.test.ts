import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { tempDir } from "./helpers.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd = projectRoot): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, join(projectRoot, "src/cli.ts"), ...args], {
      cwd,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COCSEAK_HOME: home };
  for (const name of [
    "DEEPSEEK_API_KEY",
    "COCSEAK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "COCSEAK_BASE_URL",
    "DEEPSEEK_MODEL",
    "COCSEAK_MODEL",
  ]) {
    delete env[name];
  }
  return env;
}

test("a fresh download can be configured and checked end to end", { timeout: 90_000 }, async () => {
  const dir = tempDir();
  const home = join(dir.path, "cocseak-home");
  const env = cleanEnv(home);

  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        if (req.headers.authorization !== "Bearer test-key-1234") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end('{"error":{"message":"bad key"}}');
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "deepseek-chat" }] }));
        return;
      }

      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello from cocseak"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    // 1. Bare invocation explains what to do next.
    const welcome = await run([], env);
    assert.equal(welcome.code, 0);
    assert.match(welcome.stdout, /First run:/);
    assert.match(welcome.stdout, /cocseak config set api-key/);

    // 2. Doctor says what is missing.
    const before = await run(["doctor", "--offline"], env);
    assert.equal(before.code, 1);
    assert.match(before.stdout, /not ready/);
    assert.match(before.stdout, /no API key/);

    // 3. Saving a key creates a 0600 file.
    const setKey = await run(["config", "set", "api-key", "test-key-1234"], env);
    assert.equal(setKey.code, 0);
    const configPath = join(home, "config.json");
    assert.ok(existsSync(configPath));
    assert.equal((statSync(configPath).mode & 0o777).toString(8), "600");
    assert.match(readFileSync(configPath, "utf8"), /test-key-1234/);

    // 4. Showing the config never prints the key in full.
    const shown = await run(["config"], env);
    assert.equal(shown.code, 0);
    assert.match(shown.stdout, /tes…1234/);
    assert.doesNotMatch(shown.stdout, /test-key-1234/);

    // 5. Offline doctor passes with a key present.
    const offline = await run(["doctor", "--offline"], env);
    assert.equal(offline.code, 0);
    assert.match(offline.stdout, /result: {4}ready/);

    // 6. Point it at a provider and let doctor check the key.
    const setBase = await run(["config", "set", "base-url", `http://127.0.0.1:${address.port}/v1`], env);
    assert.equal(setBase.code, 0);

    const online = await run(["doctor"], env);
    assert.equal(online.code, 0);
    assert.match(online.stdout, /ok — 1 model/);

    // 7. Run a task with no flags beyond --os: everything comes from the settings file.
    const task = await run(["--os", "--title", "first", "--task", "say hi", "--json"], env);
    assert.equal(task.code, 0, task.stderr);
    const report = JSON.parse(task.stdout.trim()) as { ok: boolean; answer: string; kap: { active: boolean } };
    assert.equal(report.ok, true);
    assert.equal(report.answer, "hello from cocseak");
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    dir.cleanup();
  }
});
