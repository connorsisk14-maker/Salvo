const defaultTimeoutMs = Number(process.env.SALVO_OPS_TIMEOUT_MS ?? 30_000);

export const baseUrl =
  process.env.SALVO_E2E_API_URL ??
  process.env.SALVO_HEALTH_MONITOR_API_URL ??
  process.env.SALVO_LOAD_API_URL ??
  process.env.SALVO_API_URL ??
  "http://localhost:8787";
const authToken = process.env.SALVO_E2E_API_TOKEN ?? process.env.SALVO_API_TOKEN ?? "";

function normalizeHeaders(initHeaders) {
  const headers = new Headers();

  if (initHeaders instanceof Headers) {
    for (const [key, value] of initHeaders.entries()) {
      headers.set(key, value);
    }
  } else if (initHeaders && typeof initHeaders === "object") {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    }
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  if (authToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${authToken}`);
  }

  const normalized = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

async function fetchWithTimeout(path, init = {}) {
  const { timeoutMs: requestedTimeoutMs, ...rest } = init;
  const timeoutMs = Number(requestedTimeoutMs ?? defaultTimeoutMs);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(`${baseUrl}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: normalizeHeaders(rest.headers)
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatErrorMessage(status, path, body) {
  const prefix = `Request to ${path} failed (status ${status}).`;
  if (!body) {
    return prefix;
  }

  if (typeof body === "string") {
    return `${prefix} ${body}`;
  }

  if (typeof body === "object") {
    const details = [];
    if (typeof body.error === "string") {
      details.push(body.error);
    }
    if (Array.isArray(body.issues)) {
      details.push(
        body.issues
          .map((issue) => {
            const pathPart = issue.path ?? "body";
            const messagePart = issue.message ?? "invalid value";
            return `${pathPart}: ${messagePart}`;
          })
          .join("; ")
      );
    }
    if (details.length > 0) {
      return `${prefix} ${details.join(" ")}`;
    }
  }

  return prefix;
}

export async function requestJson(path, init = {}) {
  const response = await fetchWithTimeout(path, init);
  const body = await readResponseBody(response);

  if (!response.ok) {
    const message = formatErrorMessage(response.status, path, body);
    const error = new Error(
      response.status === 401
        ? `${message} Authorization failed.`
        : response.status === 429
        ? `${message} Rate limited.`
        : response.status >= 500
        ? `${message} Server error.`
        : message
    );
    error.status = response.status;
    throw error;
  }

  return body;
}

export const request = requestJson;
