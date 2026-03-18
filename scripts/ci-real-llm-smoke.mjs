const provider = (process.env.SALVO_CI_REAL_LLM_PROVIDER ?? "openai").trim().toLowerCase();
const apiKey = process.env.SALVO_CI_REAL_LLM_API_KEY?.trim();

if (!apiKey) {
  throw new Error("Missing SALVO_CI_REAL_LLM_API_KEY for real-LLM smoke.");
}

function readTextFromOpenAiPayload(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim().length > 0) {
    return payload.output_text.trim();
  }

  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  for (const output of outputs) {
    const content = Array.isArray(output?.content) ? output.content : [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text.trim().length > 0) {
        return block.text.trim();
      }
    }
  }

  return "";
}

function readTextFromAnthropicPayload(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  for (const block of content) {
    if (typeof block?.text === "string" && block.text.trim().length > 0) {
      return block.text.trim();
    }
  }
  return "";
}

async function runOpenAiSmoke() {
  const endpoint =
    process.env.SALVO_CI_REAL_LLM_BASE_URL?.trim() ??
    "https://api.openai.com/v1/responses";
  const model = process.env.SALVO_CI_REAL_LLM_MODEL?.trim() ?? "gpt-4.1-mini";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: "Reply with exactly: salvo_ci_ok"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI smoke request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const text = readTextFromOpenAiPayload(payload);
  if (!text.toLowerCase().includes("salvo_ci_ok")) {
    throw new Error(`OpenAI smoke response missing token. Received: ${text || "<empty>"}`);
  }
}

async function runAnthropicSmoke() {
  const endpoint =
    process.env.SALVO_CI_REAL_LLM_BASE_URL?.trim() ??
    "https://api.anthropic.com/v1/messages";
  const model =
    process.env.SALVO_CI_REAL_LLM_MODEL?.trim() ??
    "claude-3-5-haiku-latest";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: "Reply with exactly: salvo_ci_ok"
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic smoke request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const text = readTextFromAnthropicPayload(payload);
  if (!text.toLowerCase().includes("salvo_ci_ok")) {
    throw new Error(`Anthropic smoke response missing token. Received: ${text || "<empty>"}`);
  }
}

if (provider === "openai") {
  await runOpenAiSmoke();
} else if (provider === "anthropic") {
  await runAnthropicSmoke();
} else {
  throw new Error(`Unsupported SALVO_CI_REAL_LLM_PROVIDER: ${provider}`);
}

console.log(`real-llm smoke passed for provider=${provider}`);
