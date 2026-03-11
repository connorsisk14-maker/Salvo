import { z } from "zod";
import {
  RUN_EVENT_LEVELS,
  RUN_EVENT_TYPES,
  type RunEventLevel,
  type RunEventType,
  type RunId
} from "@salvo/shared";

export const RunEventV1Schema = z.object({
  run_id: z.string().uuid(),
  sequence_no: z.number().int().nonnegative(),
  event_type: z.enum(RUN_EVENT_TYPES),
  level: z.enum(RUN_EVENT_LEVELS),
  payload_json: z.record(z.unknown()),
  schema_version: z.literal(1),
  created_at: z.string().datetime()
});

export type RunEventV1 = z.infer<typeof RunEventV1Schema>;

export type BuildRunEventInput = {
  runId: RunId;
  sequenceNo: number;
  eventType: RunEventType;
  level?: RunEventLevel;
  payload?: Record<string, unknown>;
};

export function buildRunEvent(input: BuildRunEventInput): RunEventV1 {
  return RunEventV1Schema.parse({
    run_id: input.runId,
    sequence_no: input.sequenceNo,
    event_type: input.eventType,
    level: input.level ?? "info",
    payload_json: input.payload ?? {},
    schema_version: 1,
    created_at: new Date().toISOString()
  });
}

export function validateRunEvent(value: unknown): RunEventV1 {
  return RunEventV1Schema.parse(value);
}

export function assertAppendOnly(previousSequenceNo: number, nextSequenceNo: number): void {
  if (nextSequenceNo <= previousSequenceNo) {
    throw new Error(
      `Run event sequence must increase. Received ${nextSequenceNo} after ${previousSequenceNo}.`
    );
  }
}
