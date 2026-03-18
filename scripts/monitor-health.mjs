import { baseUrl, requestJson } from "./lib/api-client.mjs";

const healthEndpoints = [
  { label: "control plane", path: "/health" },
  { label: "orchestrator", path: "/health/orchestrator" },
  { label: "research", path: "/health/research" }
];

async function monitorEndpoint(endpoint) {
  const payload = await requestJson(endpoint.path);
  const status = payload?.status ?? "unknown";
  console.log(`[monitor] ${endpoint.label} status: ${status}`);

  if (endpoint.path !== "/health" && status !== "healthy") {
    throw new Error(`${endpoint.label} reported ${status}`);
  }

  return payload;
}

async function main() {
  console.log(`[monitor] polling ${baseUrl}`);
  const errors = [];

  for (const endpoint of healthEndpoints) {
    try {
      await monitorEndpoint(endpoint);
    } catch (error) {
      console.error(`[monitor] ${endpoint.label} check failed: ${error.message}`);
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    console.error(`[monitor] failing due to ${errors.join("; ")}`);
    process.exit(1);
  }

  console.log(`[monitor] all health checks passed`);
}

main().catch((error) => {
  console.error(`[monitor] FAIL: ${error.message}`);
  process.exit(1);
});
