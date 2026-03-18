import assert from "node:assert/strict";
import test from "node:test";
import type { SentMessageInfo, Transporter } from "nodemailer";
import { EmailAdapter } from "../src/email";

test("EmailAdapter health reports not_configured when transport is absent", async () => {
  const adapter = new EmailAdapter();
  const health = await adapter.health();
  assert.equal(health.status, "not_configured");
  assert.equal(health.detail, "Configure an email transport URL to use the email adapter.");
});

test("EmailAdapter run honors provided transporter and default recipients", async () => {
  const sent: Record<string, unknown> = {};
  const transporter: Transporter<SentMessageInfo> = {
    async verify() {
      return undefined;
    },
    async sendMail(options) {
      Object.assign(sent, options);
      return {
        messageId: "msg-123",
        accepted: ["ops@example.com"],
        rejected: [],
        envelope: {
          from: "from@example.com",
          to: ["ops@example.com"]
        }
      };
    }
  } as Transporter<SentMessageInfo>;

  const adapter = new EmailAdapter(
    {
      transportUrl: "smtp://example",
      defaultFrom: "default@example.com",
      defaultRecipients: ["ops@example.com"]
    },
    { transporter }
  );

  const result = await adapter.run({
    runId: "run-1",
    payload: {
      subject: "Hello",
      text: "body"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.detail, "Email queued for delivery.");
  assert.deepEqual(sent.to, ["ops@example.com"]);
  assert.equal(sent.from, "default@example.com");
  assert.equal(sent.subject, "Hello");
});

test("EmailAdapter rejects payload without subject", async () => {
  const adapter = new EmailAdapter({
    transportUrl: "smtp://example",
    defaultFrom: "default@example.com",
    defaultRecipients: ["ops@example.com"]
  });

  const result = await adapter.run({
    runId: "run-2",
    payload: {
      text: "missing subject"
    }
  });

  assert.equal(result.ok, false);
  assert.ok(result.detail?.includes("subject"));
});
