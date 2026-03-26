import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CATALOG, resolveModelPricing } from "../src/index";

test("resolveModelPricing prefers the most specific OpenAI model match", () => {
  assert.deepEqual(resolveModelPricing("gpt-5.4-mini"), MODEL_CATALOG["gpt-5.4-mini"]);
  assert.deepEqual(resolveModelPricing("gpt-5-mini-2025-08-07"), MODEL_CATALOG["gpt-5-mini"]);
  assert.deepEqual(resolveModelPricing("gpt-4o-mini"), MODEL_CATALOG["gpt-4o-mini"]);
});

test("resolveModelPricing returns null for unknown models", () => {
  assert.equal(resolveModelPricing("unknown-model"), null);
});
