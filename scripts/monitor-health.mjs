#!/usr/bin/env node

import { existsSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import nodemailer from "nodemailer";

const fetchApi = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
if (!fetchApi) {
  console.error("monitor-health script requires Node with global fetch support.");
  process.exit(1);
}

const apiUrl = (process.env.SALVO_HEALTH_MONITOR_API_URL ?? "http://localhost:8787").replace(/\\/+$/, "");
const intervalMs = Number(process.env.SALVO_HEALTH_MONITOR_INTERVAL_MS ?? "60000");
const alertChannels = (process.env.SALVO_HEALTH_ALERT_CHANNELS ?? "stdout")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const slackWebhook = process.env.SALVO_HEALTH_SLACK_WEBHOOK_URL;
const emailTransportUrl = process.env.SALVO_HEALTH_EMAIL_TRANSPORT_URL;
const emailFrom = process.env.SALVO_HEALTH_EMAIL_FROM ?? "salvo-health@example.com";
const emailRecipients = process.env.SALVO_HEALTH_EMAIL_RECIPIENTS;
const restartLockPath = process.env.SALVO_HEALTH_RESTART_LOCK_PATH;
const token = process.env.SALVO_API_TOKEN;

const emailTransport =
  emailTransportUrl && emailRecipients
    ? nodemailer.createTransport(emailTransportUrl)
    : null;

const previousStates = new Map();

function shouldSuppressAlerts() {
  if (!restartLockPath) {
    return false;
  }
  return existsSync(restartLockPath);
}

function formatServiceDetail(service) {
  const parts = [`status=${service.status}`];
  if (service.detail) {
    parts.push(service.detail);
  }
  if (typeof service.threshold_seconds === "number") {
    parts.push(`threshold=${service.threshold_seconds}s`);
  }
  if (service.heartbeat_at) {
    parts.push(`heartbeat=${service.heartbeat_at}`);
  }
  if (service.latency !== undefined) {
    parts.push(`latency=${service.latency}ms`);
  }
  return parts.join(" · ");
}

async function sendSlackMessage(text) {
  if (!slackWebhook) {
    return;
  }
  await fetch(slackWebhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
}

async function sendEmail(subject, text) {
  if (!emailTransport || !emailRecipients) {
    return;
  }
  await emailTransport.sendMail({
    from: emailFrom,
    to: emailRecipients.split(",").map((entry) => entry.trim()).filter(Boolean),
    subject,
    text
  });
}

async function alert(message, level = "warning") {
  const prefix = level === "critical" ? "[CRITICAL]" : "[OK]";
  const payload = `${prefix} ${message}`;
  if (alertChannels.includes("stdout") || alertChannels.length === 0) {
    console.log(payload);
  }
  if (alertChannels.includes("slack")) {
    await sendSlackMessage(payload);
  }
  if (alertChannels.includes("email")) {
    const subject = `Salvo health ${level}`;
    await sendEmail(subject, payload);
  }
}

function aggregateStatus(services) {
  if (Object.values(services).some((service) => service.status === "offline")) {
    return "offline";
  }
  if (Object.values(services).some((service) => service.status === "stale")) {
    return "stale";
  }
  return "healthy";
}

function diffAndAlert(services, overallStatus) {
  for (const [name, service] of Object.entries(services)) {
    const prev = previousStates.get(name);
    if (service.status !== prev) {
      const detail = formatServiceDetail(service);
      if (service.status === "healthy" && prev && prev !== "healthy") {
        alert(`Recovered ${name}: ${detail}`, "ok");
      } else if (service.status !== "healthy") {
        alert(`Degraded ${name}: ${detail}`, "critical");
      }
      previousStates.set(name, service.status);
    }
  }
  const overallPrev = previousStates.get("__overall");
  if (overallStatus !== overallPrev) {
    if (overallStatus === "healthy") {
      alert("Overall health restored", "ok");
    } else {
      alert(`Overall health ${overallStatus}`, "warning");
    }
    previousStates.set("__overall", overallStatus);
  }
}

async function pollHealth() {
  while (true) {
    if (shouldSuppressAlerts()) {
      console.log("Alerting suppressed during planned restart.");
      await setTimeout(intervalMs);
      continue;
    }

    try {
      const response = await fetchApi(`${apiUrl}/health/all`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Received ${response.status}`);
      }
      const payload = await response.json();
      const services = payload.services ?? {};
      const overallStatus = aggregateStatus(services);
      diffAndAlert(services, overallStatus);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      alert(`Health monitor fetch failed (${detail}).`, "critical");
    }

    await setTimeout(intervalMs);
  }
}

if (intervalMs <= 0) {
  console.error("SALVO_HEALTH_MONITOR_INTERVAL_MS must be greater than 0.");
  process.exit(1);
}

void pollHealth();
