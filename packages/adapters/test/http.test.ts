import assert from "node:assert/strict";
import test from "node:test";
import { HttpAdapter } from "../src/http";

test("HttpAdapter.request builds URLs with query params and bearer auth", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const adapter = new HttpAdapter(
    "https://search.example.com/api",
    "secret-token",
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch
  );

  const response = await adapter.request({
    path: "/business",
    query: {
      q: "hvac dallas",
      limit: 5
    }
  });

  assert.equal(response.ok, true);
  assert.equal(capturedUrl, "https://search.example.com/api/business?q=hvac+dallas&limit=5");
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer secret-token");
});

test("HttpAdapter.run posts run payloads through the shared request path", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const adapter = new HttpAdapter(
    "https://worker.example.com",
    "run-token",
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch
  );

  const result = await adapter.run({
    runId: "run-123",
    payload: {
      task: "sync"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://worker.example.com/runs");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    runId: "run-123",
    payload: {
      task: "sync"
    }
  });
});
