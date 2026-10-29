import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderError } from "../src/errors.js";
import { OpenAiCompatibleProvider } from "../src/provider.js";

const sse = (chunks: unknown[]): string =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;

function provider(fetchImpl: typeof fetch, overrides: { attempts?: number; backoffMs?: number } = {}) {
  return new OpenAiCompatibleProvider({
    baseUrl: "https://provider.test/v1",
    apiKey: "k",
    model: "m",
    fetchImpl,
    backoffMs: 1,
    ...overrides,
  });
}

test("retries a transient failure and then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return new Response("busy", { status: 503 });
    return new Response(sse([{ choices: [{ delta: { content: "ok" } }] }]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const turn = await provider(fetchImpl).complete([{ role: "user", content: "hi" }], []);
  assert.equal(calls, 3);
  assert.equal(turn.content, "ok");
});

test("gives up after the configured attempts", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("busy", { status: 503 });
  }) as typeof fetch;

  await assert.rejects(
    () => provider(fetchImpl, { attempts: 2 }).complete([{ role: "user", content: "hi" }], []),
    ProviderError,
  );
  assert.equal(calls, 2);
});

test("does not retry a rejected key", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('{"error":{"message":"bad key"}}', { status: 401 });
  }) as typeof fetch;

  await assert.rejects(
    () => provider(fetchImpl).complete([{ role: "user", content: "hi" }], []),
    /HTTP 401/,
  );
  assert.equal(calls, 1);
});

test("understands a provider that ignores stream:true", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "plain",
              tool_calls: [
                { id: "c1", function: { name: "bash", arguments: '{"command":"true"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const turn = await provider(fetchImpl).complete([{ role: "user", content: "hi" }], []);
  assert.equal(turn.content, "plain");
  assert.equal(turn.toolCalls[0]?.name, "bash");
  assert.equal(turn.finishReason, "tool_calls");
  assert.equal(turn.usage?.total_tokens, 3);
});

test("rejects a 200 response that is neither a stream nor JSON", async () => {
  const fetchImpl = (async () =>
    new Response("<html>gateway</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

  await assert.rejects(
    () => provider(fetchImpl).complete([{ role: "user", content: "hi" }], []),
    /instead of an event stream/,
  );
});
