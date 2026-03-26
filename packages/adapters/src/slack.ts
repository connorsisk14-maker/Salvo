import type { Adapter, AdapterHealth, AdapterRunRequest, AdapterRunResult } from "./types";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError,
  RetryableAdapterError
} from "./reliability";

type SlackResponse = {
  ok?: boolean;
  error?: string;
  channel?: {
    id?: string;
  };
  ts?: string;
  message?: {
    ts?: string;
  };
};

export type SlackAdapterConfig = {
  botToken?: string;
  defaultChannel?: string;
  webhookUrl?: string;
};

export type SlackAdapterOptions = {
  fetch?: typeof fetch;
};

type SlackMessagePayload = {
  text?: string;
  channel?: string;
  userId?: string;
  webhookUrl?: string;
  threadTs?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  username?: string;
  iconEmoji?: string;
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
  replyBroadcast?: boolean;
};

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isUserId(value: string): boolean {
  return /^[UW][A-Z0-9]+$/i.test(value);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class SlackAdapter implements Adapter {
  readonly key = "slack";
  #botToken?: string;
  #defaultChannel?: string;
  #webhookUrl?: string;
  #fetch: typeof fetch;

  constructor(config: SlackAdapterConfig = {}, options: SlackAdapterOptions = {}) {
    this.#botToken = readString(config.botToken);
    this.#defaultChannel = readString(config.defaultChannel);
    this.#webhookUrl = readString(config.webhookUrl);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<AdapterHealth> {
    if (this.#webhookUrl) {
      return {
        status: "ready",
        detail: "Slack incoming webhook is configured."
      };
    }

    if (!this.#botToken) {
      return {
        status: "not_configured",
        detail: "Configure a Slack bot token or incoming webhook URL."
      };
    }

    try {
      const response = await this.#fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#botToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: "{}"
      });

      const payload = (await response.json()) as SlackResponse;
      if (!response.ok || !payload.ok) {
        const detail = payload.error ?? `Slack auth.test failed with ${response.status}.`;
        return { status: "error", detail };
      }

      return {
        status: "ready",
        detail: "Slack bot token is authenticated."
      };
    } catch (error) {
      return {
        status: "error",
        detail: (error as Error).message
      };
    }
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    return executeAdapterRunWithReliability(this.key, async () => {
      const payload = this.parsePayload(request.payload);
      if (payload.webhookUrl || this.#webhookUrl) {
        return this.sendViaWebhook(request.runId, payload);
      }

      return this.sendViaBot(request.runId, payload);
    });
  }

  private parsePayload(payload: Record<string, unknown>): SlackMessagePayload {
    const text = readString(payload.text);
    const channel = readString(payload.channel);
    const userId = readString(payload.userId) ?? readString(payload.user_id);
    const webhookUrl = readString(payload.webhookUrl) ?? readString(payload.webhook_url);
    const blocks = readArray(payload.blocks);
    const attachments = readArray(payload.attachments);
    const threadTs = readString(payload.threadTs) ?? readString(payload.thread_ts);
    const username = readString(payload.username);
    const iconEmoji = readString(payload.iconEmoji) ?? readString(payload.icon_emoji);

    if (!text && blocks === undefined && attachments === undefined) {
      throw new FatalAdapterError("Slack payload requires text, blocks, or attachments.");
    }

    return {
      text,
      channel,
      userId,
      webhookUrl,
      threadTs,
      blocks,
      attachments,
      username,
      iconEmoji,
      unfurlLinks: typeof payload.unfurlLinks === "boolean" ? payload.unfurlLinks : undefined,
      unfurlMedia: typeof payload.unfurlMedia === "boolean" ? payload.unfurlMedia : undefined,
      replyBroadcast: typeof payload.replyBroadcast === "boolean" ? payload.replyBroadcast : undefined
    };
  }

  private resolveWebhookUrl(payload: SlackMessagePayload): string {
    const webhookUrl = payload.webhookUrl ?? this.#webhookUrl;
    if (!webhookUrl) {
      throw new FatalAdapterError("Slack webhook URL is not configured.");
    }
    return webhookUrl;
  }

  private resolveChannel(payload: SlackMessagePayload): string {
    const channel = payload.channel ?? this.#defaultChannel;
    if (!channel) {
      throw new FatalAdapterError("Slack channel is not configured.");
    }
    return channel;
  }

  private resolveDmRecipient(payload: SlackMessagePayload): string | null {
    const userId = payload.userId;
    if (userId) {
      return userId;
    }

    const channel = payload.channel ?? this.#defaultChannel;
    if (channel && isUserId(channel)) {
      return channel;
    }

    return null;
  }

  private async sendViaWebhook(runId: string, payload: SlackMessagePayload): Promise<AdapterRunResult> {
    const webhookUrl = this.resolveWebhookUrl(payload);
    const response = await this.#fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        text: payload.text,
        blocks: payload.blocks,
        attachments: payload.attachments,
        channel: payload.channel,
        username: payload.username,
        icon_emoji: payload.iconEmoji,
        thread_ts: payload.threadTs,
        unfurl_links: payload.unfurlLinks,
        unfurl_media: payload.unfurlMedia,
        reply_broadcast: payload.replyBroadcast
      })
    });

    if (!response.ok) {
      const detail = `Slack webhook request failed with ${response.status}.`;
      if (isRetryableStatus(response.status)) {
        throw new RetryableAdapterError(detail);
      }
      return {
        ok: false,
        detail
      };
    }

    const bodyText = (await response.text()).trim();
    if (bodyText.length > 0 && bodyText.toLowerCase() !== "ok") {
      return {
        ok: false,
        detail: bodyText
      };
    }

    return {
      ok: true,
      detail: `Slack webhook message queued for ${runId}.`,
      output: {
        transport: "webhook",
        webhookUrl: webhookUrl,
        channel: payload.channel ?? null,
        text: payload.text ?? null
      }
    };
  }

  private async sendViaBot(runId: string, payload: SlackMessagePayload): Promise<AdapterRunResult> {
    const botToken = this.#botToken;
    if (!botToken) {
      throw new FatalAdapterError("Slack bot token is not configured.");
    }

    const recipient = this.resolveDmRecipient(payload);
    const channel = recipient
      ? await this.openDirectMessage(botToken, recipient)
      : this.resolveChannel(payload);

    const response = await this.#fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        channel,
        text: payload.text,
        blocks: payload.blocks,
        attachments: payload.attachments,
        thread_ts: payload.threadTs,
        unfurl_links: payload.unfurlLinks,
        unfurl_media: payload.unfurlMedia,
        reply_broadcast: payload.replyBroadcast
      })
    });

    if (!response.ok) {
      const detail = `Slack chat.postMessage failed with ${response.status}.`;
      if (isRetryableStatus(response.status)) {
        throw new RetryableAdapterError(detail);
      }
      return {
        ok: false,
        detail
      };
    }

    const body = (await response.json()) as SlackResponse;
    if (!body.ok) {
      const detail = body.error ?? "Slack chat.postMessage returned ok=false.";
      return {
        ok: false,
        detail
      };
    }

    const messageTs = body.ts ?? body.message?.ts ?? null;
    return {
      ok: true,
      detail: `Slack message posted to ${channel}.`,
      output: {
        transport: "bot",
        channel,
        message_ts: messageTs,
        text: payload.text ?? null,
        run_id: runId
      }
    };
  }

  private async openDirectMessage(botToken: string, userId: string): Promise<string> {
    const response = await this.#fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        users: userId
      })
    });

    if (!response.ok) {
      const detail = `Slack conversations.open failed with ${response.status}.`;
      if (isRetryableStatus(response.status)) {
        throw new RetryableAdapterError(detail);
      }
      throw new FatalAdapterError(detail);
    }

    const body = (await response.json()) as SlackResponse;
    if (!body.ok) {
      throw new FatalAdapterError(body.error ?? "Slack conversations.open returned ok=false.");
    }

    const channel = body.channel?.id?.trim();
    if (!channel) {
      throw new FatalAdapterError("Slack conversations.open did not return a channel id.");
    }

    return channel;
  }
}
