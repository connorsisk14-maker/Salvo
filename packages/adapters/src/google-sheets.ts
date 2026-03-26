import crypto from "node:crypto";
import type {
  Adapter,
  AdapterRunRequest,
  AdapterRunResult,
  AdapterHealth
} from "./types";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError,
  RetryableAdapterError
} from "./reliability";

type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

type TokenProvider = (
  credentials: GoogleServiceAccount,
  fetcher: typeof fetch
) => Promise<{ token: string; expiresIn: number }>;

export type GoogleSheetsAdapterConfig = {
  spreadsheetId?: string;
  credentialsJson?: string;
};

export type GoogleSheetsAdapterOptions = {
  fetch?: typeof fetch;
  tokenProvider?: TokenProvider;
};

type RunAction =
  | "read_range"
  | "append_rows"
  | "update_rows";

type ReadRangePayload = {
  action: "read_range";
  range: string;
  majorDimension?: "ROWS" | "COLUMNS";
};

type AppendRowsPayload = {
  action: "append_rows";
  range: string;
  values: unknown[];
  majorDimension?: "ROWS" | "COLUMNS";
  valueInputOption?: "RAW" | "USER_ENTERED";
  insertDataOption?: "INSERT_ROWS" | "OVERWRITE";
};

type UpdateRowsPayload = {
  action: "update_rows";
  range: string;
  values: unknown[];
  majorDimension?: "ROWS" | "COLUMNS";
  valueInputOption?: "RAW" | "USER_ENTERED";
};

type GoogleSheetsPayload = ReadRangePayload | AppendRowsPayload | UpdateRowsPayload;

type SpreadsheetMetadata = {
  properties?: {
    title?: string;
  };
};

export class GoogleSheetsAdapter implements Adapter {
  readonly key = "google_sheets";
  #spreadsheetId: string;
  #credentialsJson: string;
  #credentials: GoogleServiceAccount | null = null;
  #credentialsError?: string;
  #fetch: typeof fetch;
  #tokenProvider: TokenProvider;
  #cachedToken?: string;
  #tokenExpiresAt = 0;

  constructor(config: GoogleSheetsAdapterConfig, options: GoogleSheetsAdapterOptions = {}) {
    this.#spreadsheetId = (config.spreadsheetId ?? "").trim();
    this.#credentialsJson = (config.credentialsJson ?? "").trim();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#tokenProvider = options.tokenProvider ?? GoogleSheetsAdapter.requestTokenWithJwt;
    this.#credentials = this.parseCredentials();
  }

  async health(): Promise<AdapterHealth> {
    if (!this.#spreadsheetId) {
      return {
        status: "not_configured",
        detail: "Set a spreadsheet ID to use the Google Sheets adapter."
      };
    }

    if (!this.#credentials) {
      return {
        status: "not_configured",
        detail: this.#credentialsError ?? "Provide service account credentials to use Google Sheets."
      };
    }

    try {
      const metadata = await this.fetchSpreadsheetMetadata();
      const title = metadata.properties?.title ?? this.#spreadsheetId;
      return {
        status: "ready",
        detail: `Spreadsheet ${title} is accessible.`
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
      this.ensureConfiguration();
      const { actionDescription, output } = await this.executeAction(request.payload ?? {});
      return {
        ok: true,
        detail: `Google Sheets ${actionDescription} completed.`,
        output
      };
    });
  }

  private parseCredentials(): GoogleServiceAccount | null {
    if (!this.#credentialsJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(this.#credentialsJson);
      const clientEmail = parsed?.client_email;
      const privateKey = parsed?.private_key;
      if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
        this.#credentialsError = "Service account JSON must include client_email and private_key.";
        return null;
      }

      return {
        client_email: clientEmail.trim(),
        private_key: privateKey.trim(),
        token_uri: (typeof parsed?.token_uri === "string" && parsed.token_uri.trim()) || DEFAULT_TOKEN_URI
      };
    } catch (error) {
      this.#credentialsError = "Failed to parse Google service account credentials.";
      return null;
    }
  }

  private ensureConfiguration(): void {
    if (!this.#spreadsheetId) {
      throw new FatalAdapterError("Spreadsheet ID is not configured.");
    }
    if (!this.#credentials) {
      throw new FatalAdapterError(this.#credentialsError ?? "Google Sheets credentials are not configured.");
    }
  }

  private async executeAction(payload: Record<string, unknown>) {
    const action = (payload.action as RunAction | undefined) ?? "";
    if (!action) {
      throw new FatalAdapterError("Google Sheets action is required.");
    }

    const range = this.requireString(payload.range, "range");

    if (action === "read_range") {
      const majorDimension = this.coerceDimension((payload as ReadRangePayload).majorDimension);
      const response = await this.callSpreadsheetEndpoint(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.#spreadsheetId)}/values/${encodeURIComponent(range)}`,
        {
          method: "GET",
          headers: {}
        },
        `majorDimension=${majorDimension}`
      );
      return {
        actionDescription: `read range ${range}`,
        output: response
      };
    }

    if (action === "append_rows" || action === "update_rows") {
      const values = this.coerceRows(payload.values);
      const majorDimension = this.coerceDimension((payload as AppendRowsPayload | UpdateRowsPayload).majorDimension);
      const valueInputOption = this.coerceValueInputOption(
        (payload as AppendRowsPayload | UpdateRowsPayload).valueInputOption
      );
      const body = {
        values,
        majorDimension
      } as Record<string, unknown>;

      if (action === "append_rows") {
        const insertDataOption = this.coerceInsertDataOption((payload as AppendRowsPayload).insertDataOption);
        const response = await this.callSpreadsheetEndpoint(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.#spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
          {
            method: "POST",
            body: JSON.stringify(body)
          },
          `valueInputOption=${valueInputOption}&insertDataOption=${insertDataOption}&includeValuesInResponse=true`
        );
        return {
          actionDescription: `append rows to ${range}`,
          output: response
        };
      }

      const response = await this.callSpreadsheetEndpoint(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.#spreadsheetId)}/values/${encodeURIComponent(range)}`,
        {
          method: "PUT",
          body: JSON.stringify(body)
        },
        `valueInputOption=${valueInputOption}`
      );
      return {
        actionDescription: `update rows in ${range}`,
        output: response
      };
    }

    throw new FatalAdapterError(`Unsupported Google Sheets action: ${action}`);
  }

  private coerceDimension(value: unknown): "ROWS" | "COLUMNS" {
    if (value === "COLUMNS") {
      return "COLUMNS";
    }
    return "ROWS";
  }

  private coerceValueInputOption(value: unknown): "RAW" | "USER_ENTERED" {
    return value === "USER_ENTERED" ? "USER_ENTERED" : "RAW";
  }

  private coerceInsertDataOption(value: unknown): "INSERT_ROWS" | "OVERWRITE" {
    return value === "OVERWRITE" ? "OVERWRITE" : "INSERT_ROWS";
  }

  private coerceRows(value: unknown): unknown[][] {
    if (!Array.isArray(value)) {
      throw new FatalAdapterError("Google Sheets values must be an array of rows.");
    }
    if (value.some((row) => !Array.isArray(row))) {
      throw new FatalAdapterError("Each Google Sheets row must be an array of cells.");
    }
    return value as unknown[][];
  }

  private requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new FatalAdapterError(`Google Sheets ${label} must be a non-empty string.`);
    }
    return value.trim();
  }

  private async fetchSpreadsheetMetadata(): Promise<SpreadsheetMetadata> {
    return this.callSpreadsheetEndpoint(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.#spreadsheetId)}`,
      { method: "GET" },
      "fields=spreadsheetId%2Cproperties/title"
    );
  }

  private async callSpreadsheetEndpoint(
    url: string,
    init: RequestInit,
    query = ""
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const separator = url.includes("?") ? "&" : "?";
    const fullUrl = query ? `${url}${separator}${query}` : url;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`
    };
    if (init.method && init.method !== "GET" && init.body) {
      headers["content-type"] = "application/json";
    }

    try {
      const response = await this.#fetch(fullUrl, {
        ...init,
        headers: {
          ...headers,
          ...(init.headers ?? {})
        }
      });

      const text = await response.text();
      if (!response.ok) {
        const message = text || `Google Sheets API responded with ${response.status}.`;
        if (response.status >= 500) {
          throw new RetryableAdapterError(message);
        }
        throw new FatalAdapterError(message);
      }

      if (!text) {
        return {};
      }

      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    } catch (error) {
      if (error instanceof FatalAdapterError || error instanceof RetryableAdapterError) {
        throw error;
      }
      throw new RetryableAdapterError((error as Error).message);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.#cachedToken && Date.now() < this.#tokenExpiresAt - 16_000) {
      return this.#cachedToken;
    }

    if (!this.#credentials) {
      throw new FatalAdapterError("Google Sheets credentials are not configured.");
    }

    try {
      const tokenResponse = await this.#tokenProvider(this.#credentials, this.#fetch);
      this.#cachedToken = tokenResponse.token;
      this.#tokenExpiresAt = Date.now() + tokenResponse.expiresIn * 1000;
      return this.#cachedToken;
    } catch (error) {
      throw new RetryableAdapterError((error as Error).message);
    }
  }

  private static async requestTokenWithJwt(
    credentials: GoogleServiceAccount,
    fetcher: typeof fetch
  ): Promise<{ token: string; expiresIn: number }> {
    const now = Math.floor(Date.now() / 1000);
    const header = GoogleSheetsAdapter.base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = GoogleSheetsAdapter.base64UrlEncode(
      JSON.stringify({
        iss: credentials.client_email,
        scope: GOOGLE_SHEETS_SCOPE,
        aud: credentials.token_uri ?? DEFAULT_TOKEN_URI,
        exp: now + 3600,
        iat: now
      })
    );
    const signer = crypto.createSign("RSA-SHA256");
    const headerAndPayload = `${header}.${payload}`;
    signer.update(headerAndPayload);
    signer.end();
    const signature = GoogleSheetsAdapter.base64UrlEncode(signer.sign(credentials.private_key));
    const assertion = `${headerAndPayload}.${signature}`;
    const response = await fetcher(credentials.token_uri ?? DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      }).toString()
    });

    if (!response.ok) {
      const message = await response.text();
      throw new RetryableAdapterError(
        message || `Google OAuth token request failed with ${response.status}.`
      );
    }

    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new FatalAdapterError("Google OAuth response did not include an access token.");
    }

    return {
      token: json.access_token,
      expiresIn: json.expires_in ?? 3600
    };
  }

  private static base64UrlEncode(value: string | Buffer): string {
    const buffer = typeof value === "string" ? Buffer.from(value) : value;
    return buffer
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }
}
