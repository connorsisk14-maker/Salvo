import nodemailer from "nodemailer";
import type { SentMessageInfo, Transporter } from "nodemailer";
import type { Adapter, AdapterHealth, AdapterRunRequest, AdapterRunResult } from "./types";

export type EmailAdapterConfig = {
  transportUrl?: string;
  defaultFrom?: string;
  defaultRecipients?: string[];
};

export type EmailAdapterOptions = {
  transporter?: Transporter<SentMessageInfo>;
};

type EmailPayload = {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
  subject: string;
  text?: string;
  html?: string;
};

export class EmailAdapter implements Adapter {
  readonly key = "email";
  #transportUrl: string;
  #defaultFrom?: string;
  #defaultRecipients: string[];
  #transporter?: Transporter<SentMessageInfo>;

  constructor(config: EmailAdapterConfig = {}, options: EmailAdapterOptions = {}) {
    this.#transportUrl = config.transportUrl?.trim() ?? "";
    this.#defaultFrom = config.defaultFrom?.trim();
    this.#defaultRecipients = (config.defaultRecipients ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    this.#transporter = options.transporter;
  }

  async health(): Promise<AdapterHealth> {
    if (!this.#transportUrl && !this.#transporter) {
      return {
        status: "not_configured",
        detail: "Configure an email transport URL to use the email adapter."
      };
    }

    try {
      await this.ensureTransporter().verify();
      return {
        status: "ready",
        detail: "Email transport connection verified."
      };
    } catch (error) {
      return {
        status: "error",
        detail: (error as Error).message
      };
    }
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    try {
      const payload = this.parsePayload(request.payload);
      const transporter = this.ensureTransporter();
      const message = this.buildMessage(payload);
      const info = await transporter.sendMail(message);
      return {
        ok: true,
        detail: "Email queued for delivery.",
        output: {
          messageId: info.messageId,
          accepted: info.accepted ?? [],
          rejected: info.rejected ?? [],
          envelope: info.envelope ?? {}
        }
      };
    } catch (error) {
      return {
        ok: false,
        detail: (error as Error).message
      };
    }
  }

  private parsePayload(payload: Record<string, unknown>): EmailPayload {
    const subject = this.readRequiredString(payload, "subject");
    const text = this.readString(payload, "text");
    const html = this.readString(payload, "html");
    if (!text && !html) {
      throw new Error("Email payload requires either `text` or `html` content.");
    }

    return {
      subject,
      text,
      html,
      from: this.readString(payload, "from"),
      to: this.readRecipientLike(payload, "to"),
      cc: this.readRecipientLike(payload, "cc"),
      bcc: this.readRecipientLike(payload, "bcc")
    };
  }

  private buildMessage(payload: EmailPayload): nodemailer.SendMailOptions {
    const from = payload.from?.trim() || this.#defaultFrom;
    if (!from) {
      throw new Error("Email sender address is not configured.");
    }

    const toList = this.normalizeRecipients(payload.to);
    const ccList = this.normalizeRecipients(payload.cc);
    const bccList = this.normalizeRecipients(payload.bcc);
    const primaryRecipients = toList.length > 0 ? toList : this.#defaultRecipients;
    if (primaryRecipients.length === 0) {
      throw new Error("Email requires at least one recipient.");
    }

    return {
      from,
      to: primaryRecipients,
      cc: ccList.length > 0 ? ccList : undefined,
      bcc: bccList.length > 0 ? bccList : undefined,
      subject: payload.subject,
      text: payload.text,
      html: payload.html
    };
  }

  private normalizeRecipients(value?: string | string[]): string[] {
    const entries: string[] = [];
    const pushValue = (candidate: string) => {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        entries.push(trimmed);
      }
    };

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          pushValue(item);
        }
      }
    } else if (typeof value === "string") {
      for (const item of value.split(",")) {
        pushValue(item);
      }
    }

    return entries;
  }

  private readRecipientLike(payload: Record<string, unknown>, key: string): string | string[] | undefined {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value;
    }
    return undefined;
  }

  private readRequiredString(payload: Record<string, unknown>, key: string): string {
    const value = this.readString(payload, key);
    if (!value) {
      throw new Error(`Email payload requires ${key}.`);
    }
    return value;
  }

  private readString(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private ensureTransporter(): Transporter<SentMessageInfo> {
    if (this.#transporter) {
      return this.#transporter;
    }
    if (!this.#transportUrl) {
      throw new Error("Email transport URL is not configured.");
    }
    this.#transporter = nodemailer.createTransport(this.#transportUrl);
    return this.#transporter;
  }
}

