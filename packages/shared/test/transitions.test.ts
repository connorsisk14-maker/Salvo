import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertContractTransition,
  assertRunTransition,
  assertTaskTransition
} from "../src/index";

test("task transitions reject invalid moves", () => {
  assert.throws(() => assertTaskTransition("queued", "completed"));
});

test("contract transitions reject invalid moves", () => {
  assert.throws(() => assertContractTransition("active", "approved"));
});

test("run transitions reject invalid moves", () => {
  assert.throws(() => assertRunTransition("completed", "running"));
});
