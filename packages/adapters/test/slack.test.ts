import assert from "node:assert/strict";
import test from "node:test";
import { SlackAdapter } from "../src/slack";

test("SlackAdapter health reports not_configured without auth or webhook", async () => {
  const adapter = new SlackAdapter();
  const health = await adapter.health();
  assert.equal(health.status, "not_configured");
});

test("SlackAdapter posts channel messages with a bot token", async () => {
  const capturedUrls: string[] = [];
  const capturedBodies: string[] = [];
  const adapter = new SlackAdapter(
    {
      botToken: "xoxb-test",
      defaultChannel: "#alerts"
    },
    {
      fetch: async (url, init) => {
        capturedUrls.push(String(url));
        capturedBodies.push(String(init?.body ?? ""));
        if (String(url).includes("/auth.test")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            channel: "C123",
            ts: "1710000000.000200"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );

  const health = await adapter.health();
  assert.equal(health.status, "ready");

  const result = await adapter.run({
    runId: "run-1",
    payload: {
      text: "Deployment complete"
    }
  });

  assert.equal(result.ok, true);
  assert.ok(capturedUrls.some((url) => url.includes("/chat.postMessage")));
  assert.equal(JSON.parse(capturedBodies.at(-1) ?? "{}").channel, "#alerts");
});

test("SlackAdapter opens a DM when given a user ID", async () => {
  const capturedUrls: string[] = [];
  const adapter = new SlackAdapter(
    {
      botToken: "xoxb-test"
    },
    {
      fetch: async (url, init) => {
        capturedUrls.push(String(url));
        if (String(url).includes("/conversations.open")) {
          return new Response(
            JSON.stringify({
              ok: true,
              channel: {
                id: "D123"
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            channel: "D123",
            ts: "1710000000.000300"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
    }
  );

  const result = await adapter.run({
    runId: "run-2",
    payload: {
      text: "Private update",
      userId: "U123"
    }
  });

  assert.equal(result.ok, true);
  assert.ok(capturedUrls.some((url) => url.includes("/conversations.open")));
  assert.ok(capturedUrls.some((url) => url.includes("/chat.postMessage")));
});

test("SlackAdapter sends webhooks when configured", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const adapter = new SlackAdapter(
    {
      webhookUrl: "https://hooks.slack.test/abc"
    },
    {
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body ?? "");
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
    }
  );

  const result = await adapter.run({
    runId: "run-3",
    payload: {
      text: "Webhook notice"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://hooks.slack.test/abc");
  assert.equal(JSON.parse(capturedBody).text, "Webhook notice");
});
