import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCostMetrics,
  listIntegrations,
  updateIntegrationConfig,
  type ApiCostMetrics,
  type ApiIntegration
} from "../api/control-plane";

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatUpdated(value?: string): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleTimeString();
}

export function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<ApiIntegration[]>([]);
  const [costs, setCosts] = useState<ApiCostMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const initialized = useRef(false);

  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseAnonKey, setSupabaseAnonKey] = useState("");
  const [llmProvider, setLlmProvider] = useState<"anthropic" | "openai" | "custom">("anthropic");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmDefaultModel, setLlmDefaultModel] = useState("");
  const [processCommand, setProcessCommand] = useState("");
  const [httpBaseUrl, setHttpBaseUrl] = useState("");
  const [httpToken, setHttpToken] = useState("");
  const [googleSpreadsheetId, setGoogleSpreadsheetId] = useState("");
  const [googleCredentials, setGoogleCredentials] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackDefaultChannel, setSlackDefaultChannel] = useState("");
  const [slackWebhookUrl, setSlackWebhookUrl] = useState("");
  const [emailTransportUrl, setEmailTransportUrl] = useState("");
  const [emailDefaultFrom, setEmailDefaultFrom] = useState("");
  const [emailDefaultRecipients, setEmailDefaultRecipients] = useState("");

  async function refresh() {
    try {
      const [nextIntegrations, nextCosts] = await Promise.all([
        listIntegrations(),
        getCostMetrics()
      ]);
      setIntegrations(nextIntegrations);
      setCosts(nextCosts);
      setError(null);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const integrationMap = useMemo(
    () =>
      new Map(integrations.map((integration) => [integration.key, integration])),
    [integrations]
  );

  const supabase = integrationMap.get("supabase");
  const llmApi = integrationMap.get("llm_api");
  const processIntegration = integrationMap.get("process");
  const http = integrationMap.get("http");
  const googleSheetsIntegration = integrationMap.get("google_sheets");
  const slackIntegration = integrationMap.get("slack");
  const email = integrationMap.get("email");

  useEffect(() => {
    if (initialized.current) {
      return;
    }
    if (!supabase && !llmApi && !processIntegration && !http && !googleSheetsIntegration && !slackIntegration && !email) {
      return;
    }

    const supabaseConfig = (supabase?.config ?? {}) as { url?: string };
    const llmConfig = (llmApi?.config ?? {}) as {
      provider?: "anthropic" | "openai" | "custom";
      base_url?: string;
      default_model?: string;
    };
    const processConfig = (processIntegration?.config ?? {}) as { command?: string };
    const httpConfig = (http?.config ?? {}) as { base_url?: string };
    const googleConfig = (googleSheetsIntegration?.config ?? {}) as { spreadsheet_id?: string };
    const slackConfig = (slackIntegration?.config ?? {}) as {
      bot_token_configured?: boolean;
      default_channel?: string;
      webhook_url_configured?: boolean;
    };
    const emailConfig = (email?.config ?? {}) as {
      default_from?: string;
      default_recipients?: string[];
    };

    setSupabaseUrl(supabaseConfig.url ?? "");
    setLlmProvider(llmConfig.provider ?? "anthropic");
    setLlmBaseUrl(llmConfig.base_url ?? "");
    setLlmDefaultModel(llmConfig.default_model ?? "");
    setProcessCommand(processConfig.command ?? "");
    setHttpBaseUrl(httpConfig.base_url ?? "");
    setGoogleSpreadsheetId(googleConfig.spreadsheet_id ?? "");
    setSlackBotToken("");
    setSlackDefaultChannel(slackConfig.default_channel ?? "");
    setSlackWebhookUrl("");
    setEmailDefaultFrom(emailConfig.default_from ?? "");
    setEmailDefaultRecipients((emailConfig.default_recipients ?? []).join(", "));
    initialized.current = true;
  }, [email, googleSheetsIntegration, http, llmApi, processIntegration, slackIntegration, supabase]);

  async function saveConfig(
    key: "supabase" | "llm_api" | "process" | "http" | "google_sheets" | "slack" | "email",
    payload: Record<string, unknown>
  ) {
    setBusyKey(key);
    try {
      await updateIntegrationConfig(key, payload);
      if (key === "supabase") {
        setSupabaseAnonKey("");
      }
      if (key === "llm_api") {
        setLlmApiKey("");
      }
      if (key === "http") {
        setHttpToken("");
      }
      if (key === "google_sheets") {
        setGoogleCredentials("");
      }
      if (key === "slack") {
        setSlackBotToken("");
        setSlackWebhookUrl("");
      }
      if (key === "email") {
        setEmailTransportUrl("");
      }
      await refresh();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="content clip-card">
      <header className="content-header">
        <h1>Connectors & Integrations</h1>
        <p className="muted">
          Live connector readiness plus estimated cost rollups by model and agent profile.
        </p>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="panel">
        <h2>Integrations</h2>
        <table className="grid-table">
          <thead>
            <tr>
              <th>Connector</th>
              <th>Status</th>
              <th>Detail</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map((integration) => (
              <tr key={integration.key}>
                <td>{integration.label}</td>
                <td>
                  <span className={`status-pill status-${integration.status}`}>
                    {integration.status}
                  </span>
                </td>
                <td>{integration.detail}</td>
                <td>{formatUpdated(integration.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Update Connector Config</h2>
        <div className="integration-config-grid">
          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConfig("supabase", {
                url: supabaseUrl,
                anonKey: supabaseAnonKey
              });
            }}
          >
            <h3>Supabase</h3>
            <label>
              URL
              <input
                value={supabaseUrl}
                onChange={(event) => setSupabaseUrl(event.target.value)}
                placeholder="https://your-project.supabase.co"
              />
            </label>
            <label>
              Anon key (optional update)
              <input
                value={supabaseAnonKey}
                onChange={(event) => setSupabaseAnonKey(event.target.value)}
                placeholder="Paste to update key"
                type="password"
              />
            </label>
            <p className="muted">
              Current key:{" "}
              {String(((supabase?.config ?? {}) as { anon_key_configured?: boolean }).anon_key_configured ?? false)}
            </p>
            <button className="button-link" type="submit" disabled={busyKey === "supabase"}>
              {busyKey === "supabase" ? "Saving..." : "Save Supabase"}
            </button>
          </form>

          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConfig("llm_api", {
                provider: llmProvider,
                apiKey: llmApiKey,
                baseUrl: llmBaseUrl,
                defaultModel: llmDefaultModel
              });
            }}
          >
            <h3>LLM API</h3>
            <label>
              Provider
              <select
                value={llmProvider}
                onChange={(event) =>
                  setLlmProvider(event.target.value as "anthropic" | "openai" | "custom")
                }
              >
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="custom">custom</option>
              </select>
            </label>
            <label>
              API key (optional update)
              <input
                value={llmApiKey}
                onChange={(event) => setLlmApiKey(event.target.value)}
                placeholder="Paste to update API key"
                type="password"
              />
            </label>
            <label>
              Base URL
              <input
                value={llmBaseUrl}
                onChange={(event) => setLlmBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label>
              Default model
              <input
                value={llmDefaultModel}
                onChange={(event) => setLlmDefaultModel(event.target.value)}
                placeholder="e.g. gpt-4o, claude-3-5-sonnet-latest, mistral-large"
              />
            </label>
            <p className="muted">
              Current API key:{" "}
              {String(((llmApi?.config ?? {}) as { api_key_configured?: boolean }).api_key_configured ?? false)}
            </p>
            <button className="button-link" type="submit" disabled={busyKey === "llm_api"}>
              {busyKey === "llm_api" ? "Saving..." : "Save LLM API"}
            </button>
          </form>

          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConfig("process", {
                command: processCommand
              });
            }}
          >
            <h3>Process Adapter</h3>
            <label>
              Command
              <input
                value={processCommand}
                onChange={(event) => setProcessCommand(event.target.value)}
                placeholder="pnpm --filter @salvo/agent-runner runner -- --run-id <id>"
              />
            </label>
            <button className="button-link" type="submit" disabled={busyKey === "process"}>
              {busyKey === "process" ? "Saving..." : "Save Process Adapter"}
            </button>
          </form>

          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveConfig("http", {
                baseUrl: httpBaseUrl,
                token: httpToken
              });
            }}
          >
            <h3>HTTP Adapter</h3>
            <label>
              Base URL
              <input
                value={httpBaseUrl}
                onChange={(event) => setHttpBaseUrl(event.target.value)}
                placeholder="https://api.example.com"
              />
            </label>
            <label>
              Token (optional update)
              <input
                value={httpToken}
                onChange={(event) => setHttpToken(event.target.value)}
                placeholder="Paste to update token"
                type="password"
              />
            </label>
            <p className="muted">
              Current token:{" "}
              {String(((http?.config ?? {}) as { token_configured?: boolean }).token_configured ?? false)}
            </p>
            <button className="button-link" type="submit" disabled={busyKey === "http"}>
              {busyKey === "http" ? "Saving..." : "Save HTTP Adapter"}
            </button>
          </form>

          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              const payload: Record<string, unknown> = {};
              if (googleSpreadsheetId.trim().length > 0) {
                payload.spreadsheetId = googleSpreadsheetId.trim();
              }
              if (googleCredentials.trim().length > 0) {
                payload.credentialsJson = googleCredentials;
              }
              if (Object.keys(payload).length === 0) {
                setError("Provide a spreadsheet ID or new credentials to update Google Sheets.");
                return;
              }
              void saveConfig("google_sheets", payload);
            }}
          >
            <h3>Google Sheets</h3>
            <label>
              Spreadsheet ID
              <input
                value={googleSpreadsheetId}
                onChange={(event) => setGoogleSpreadsheetId(event.target.value)}
                placeholder="Spreadsheet ID"
              />
            </label>
            <label>
              Service account credentials (JSON)
              <textarea
                value={googleCredentials}
                onChange={(event) => setGoogleCredentials(event.target.value)}
                placeholder="Paste service account JSON"
                rows={4}
              />
            </label>
            <p className="muted">
              Credentials configured:{" "}
              {String(
                ((googleSheetsIntegration?.config ?? {}) as { credentials_configured?: boolean })
                  .credentials_configured ?? false
              )}
            </p>
            <button className="button-link" type="submit" disabled={busyKey === "google_sheets"}>
              {busyKey === "google_sheets" ? "Saving..." : "Save Google Sheets"}
            </button>
          </form>

          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              const payload: Record<string, unknown> = {};
              if (slackBotToken.trim().length > 0) {
                payload.botToken = slackBotToken.trim();
              }
              if (slackDefaultChannel.trim().length > 0) {
                payload.defaultChannel = slackDefaultChannel.trim();
              }
              if (slackWebhookUrl.trim().length > 0) {
                payload.webhookUrl = slackWebhookUrl.trim();
              }
              if (Object.keys(payload).length === 0) {
                setError("Provide a Slack bot token, default channel, or webhook URL.");
                return;
              }
              void saveConfig("slack", payload);
            }}
          >
            <h3>Slack Adapter</h3>
            <label>
              Bot token
              <input
                value={slackBotToken}
                onChange={(event) => setSlackBotToken(event.target.value)}
                placeholder="xoxb-..."
                type="password"
              />
            </label>
            <label>
              Default channel
              <input
                value={slackDefaultChannel}
                onChange={(event) => setSlackDefaultChannel(event.target.value)}
                placeholder="#alerts"
              />
            </label>
            <label>
              Incoming webhook URL
              <input
                value={slackWebhookUrl}
                onChange={(event) => setSlackWebhookUrl(event.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                type="password"
              />
            </label>
            <p className="muted">
              Bot configured:{" "}
              {String(((slackIntegration?.config ?? {}) as { bot_token_configured?: boolean }).bot_token_configured ?? false)}
            </p>
            <button className="button-link" type="submit" disabled={busyKey === "slack"}>
              {busyKey === "slack" ? "Saving..." : "Save Slack Adapter"}
            </button>
          </form>

          <form
            className="integration-form"
            onSubmit={(event) => {
              event.preventDefault();
              const payload: Record<string, unknown> = {};
              if (emailTransportUrl.trim().length > 0) {
                payload.transportUrl = emailTransportUrl.trim();
              }
              if (emailDefaultFrom.trim().length > 0) {
                payload.defaultFrom = emailDefaultFrom.trim();
              }
              const recipients = emailDefaultRecipients
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean);
              if (recipients.length > 0) {
                payload.defaultRecipients = recipients;
              }
              if (Object.keys(payload).length === 0) {
                setError("Provide an email transport URL, default sender, or default recipients.");
                return;
              }
              void saveConfig("email", payload);
            }}
          >
            <h3>Email Adapter</h3>
            <label>
              Transport URL
              <input
                value={emailTransportUrl}
                onChange={(event) => setEmailTransportUrl(event.target.value)}
                placeholder="smtp://user:pass@mail.example.com:587"
              />
            </label>
            <label>
              Default from
              <input
                value={emailDefaultFrom}
                onChange={(event) => setEmailDefaultFrom(event.target.value)}
                placeholder="ops@example.com"
              />
            </label>
            <label>
              Default recipients
              <input
                value={emailDefaultRecipients}
                onChange={(event) => setEmailDefaultRecipients(event.target.value)}
                placeholder="ops@example.com, owner@example.com"
              />
            </label>
            <p className="muted">
              Transport configured:{" "}
              {String(
                ((email?.config ?? {}) as { transport_url_configured?: boolean }).transport_url_configured ?? false
              )}
            </p>
            <button className="button-link" type="submit" disabled={busyKey === "email"}>
              {busyKey === "email" ? "Saving..." : "Save Email Adapter"}
            </button>
          </form>
        </div>
      </section>

      <section className="panel">
        <h2>Cost Overview</h2>
        {costs ? (
          <>
            <p className="muted">
              Updated: {formatUpdated(costs.updated_at)} | Estimated: {String(costs.estimated)}
            </p>
            <div className="cost-grid">
              <article className="cost-card">
                <h3>Total Cost</h3>
                <p className="mono">{formatUsd(costs.totals.cost_usd)}</p>
              </article>
              <article className="cost-card">
                <h3>Runs</h3>
                <p className="mono">{costs.totals.runs}</p>
              </article>
              <article className="cost-card">
                <h3>Input Tokens</h3>
                <p className="mono">{costs.totals.input_tokens}</p>
              </article>
              <article className="cost-card">
                <h3>Output Tokens</h3>
                <p className="mono">{costs.totals.output_tokens}</p>
              </article>
            </div>

            <h3>By Model</h3>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Runs</th>
                  <th>Input Tokens</th>
                  <th>Output Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {costs.by_model.map((row) => (
                  <tr key={row.model}>
                    <td className="mono">{row.model}</td>
                    <td>{row.runs}</td>
                    <td>{row.input_tokens}</td>
                    <td>{row.output_tokens}</td>
                    <td className="mono">{formatUsd(row.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>By Agent</h3>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Agent Profile</th>
                  <th>Runs</th>
                  <th>Input Tokens</th>
                  <th>Output Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {costs.by_agent_profile.map((row) => (
                  <tr key={row.agent_profile}>
                    <td>{row.agent_profile}</td>
                    <td>{row.runs}</td>
                    <td>{row.input_tokens}</td>
                    <td>{row.output_tokens}</td>
                    <td className="mono">{formatUsd(row.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">Loading cost metrics...</p>
        )}
      </section>
    </div>
  );
}
