import assert from "node:assert/strict";
import test from "node:test";
import {
  executeAdapterRunWithReliability,
  FatalAdapterError,
  RetryableAdapterError,
  resetCircuitBreakerState
} from "../src/reliability";

const noSleep = async (_ms: number) => undefined;

test("retryable errors are retried until success", async () => {
  resetCircuitBreakerState();
  let attempts = 0;

  const result = await executeAdapterRunWithReliability(
    "retryable-test",
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new RetryableAdapterError("temporary failure");
      }
      return { ok: true, detail: "done" };
    },
    {
      maxRetries: 4,
      baseDelayMs: 0,
      jitterMs: 0,
      failureThreshold: 10,
      cooldownMs: 0,
      sleep: noSleep
    }
  );

  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
});

test("circuit breaks after repeated retryable failures", async () => {
  resetCircuitBreakerState();
  const key = "circuit-test";
  let invocations = 0;
  const options = {
    maxRetries: 0,
    baseDelayMs: 0,
    jitterMs: 0,
    failureThreshold: 2,
    cooldownMs: 10_000,
    sleep: noSleep
  };

  await executeAdapterRunWithReliability(key, async () => {
    invocations += 1;
    throw new RetryableAdapterError("still failing");
  }, options);

  await executeAdapterRunWithReliability(key, async () => {
    invocations += 1;
    throw new RetryableAdapterError("still failing");
  }, options);

  const beforeCircuit = invocations;
  const result = await executeAdapterRunWithReliability(key, async () => {
    invocations += 1;
    throw new RetryableAdapterError("still failing");
  }, options);

  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("Circuit breaker"));
  assert.equal(invocations, beforeCircuit);
});

test("fatal errors stop retries immediately", async () => {
  resetCircuitBreakerState();
  let attempts = 0;

  const result = await executeAdapterRunWithReliability(
    "fatal-test",
    async () => {
      attempts += 1;
      throw new FatalAdapterError("irrecoverable");
    },
    {
      maxRetries: 3,
      baseDelayMs: 0,
      jitterMs: 0,
      failureThreshold: 5,
      cooldownMs: 0,
      sleep: noSleep
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.detail, "irrecoverable");
  assert.equal(attempts, 1);
});
