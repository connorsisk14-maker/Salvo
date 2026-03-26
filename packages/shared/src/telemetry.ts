import { randomUUID } from "node:crypto";
import { createLogger, type StructuredLogLevel } from "./logger";

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

export type SpanAttributes = Record<string, unknown>;

export type TelemetryLogger = ReturnType<typeof createLogger>;

export type TelemetrySpanEvent = {
  type: "span.start" | "span.end";
  timestamp: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  duration_ms?: number;
  attributes?: SpanAttributes;
  error?: Record<string, unknown>;
};

export type TelemetrySink = (event: TelemetrySpanEvent) => void;

let telemetrySink: TelemetrySink | null = null;

export function setTelemetrySink(next: TelemetrySink | null): void {
  telemetrySink = next;
}

export function createTraceContext(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? randomUUID(),
    spanId: randomUUID(),
    parentSpanId: parent?.spanId
  };
}

function emitSpan(event: TelemetrySpanEvent): void {
  if (telemetrySink) {
    telemetrySink(event);
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

export async function withTelemetrySpan<T>(input: {
  logger: TelemetryLogger;
  name: string;
  attributes?: SpanAttributes;
  level?: StructuredLogLevel;
  parent?: TraceContext;
  onEnd?: (result: {
    traceContext: TraceContext;
    durationMs: number;
    error?: unknown;
  }) => void | Promise<void>;
}, handler: (traceContext: TraceContext) => Promise<T> | T): Promise<T> {
  const traceContext = createTraceContext(input.parent);
  const level = input.level ?? "info";
  const startedAt = Date.now();

  input.logger[level](`${input.name}.started`, {
    trace_id: traceContext.traceId,
    span_id: traceContext.spanId,
    parent_span_id: traceContext.parentSpanId ?? null,
    ...input.attributes
  });
  emitSpan({
    type: "span.start",
    timestamp: new Date().toISOString(),
    trace_id: traceContext.traceId,
    span_id: traceContext.spanId,
    parent_span_id: traceContext.parentSpanId ?? null,
    name: input.name,
    attributes: input.attributes
  });

  try {
    const result = await handler(traceContext);
    const durationMs = Date.now() - startedAt;
    input.logger.info(`${input.name}.completed`, {
      trace_id: traceContext.traceId,
      span_id: traceContext.spanId,
      parent_span_id: traceContext.parentSpanId ?? null,
      duration_ms: durationMs,
      ...input.attributes
    });
    emitSpan({
      type: "span.end",
      timestamp: new Date().toISOString(),
      trace_id: traceContext.traceId,
      span_id: traceContext.spanId,
      parent_span_id: traceContext.parentSpanId ?? null,
      name: input.name,
      duration_ms: durationMs,
      attributes: input.attributes
    });
    if (input.onEnd) {
      await input.onEnd({ traceContext, durationMs });
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    input.logger.error(`${input.name}.failed`, {
      trace_id: traceContext.traceId,
      span_id: traceContext.spanId,
      parent_span_id: traceContext.parentSpanId ?? null,
      duration_ms: durationMs,
      error: serializeError(error),
      ...input.attributes
    });
    emitSpan({
      type: "span.end",
      timestamp: new Date().toISOString(),
      trace_id: traceContext.traceId,
      span_id: traceContext.spanId,
      parent_span_id: traceContext.parentSpanId ?? null,
      name: input.name,
      duration_ms: durationMs,
      attributes: input.attributes,
      error: serializeError(error)
    });
    if (input.onEnd) {
      await input.onEnd({ traceContext, durationMs, error });
    }
    throw error;
  }
}

export function startTelemetrySpan(input: {
  logger: TelemetryLogger;
  name: string;
  attributes?: SpanAttributes;
  level?: StructuredLogLevel;
  parent?: TraceContext;
}): {
  traceContext: TraceContext;
  end: (error?: unknown) => void;
} {
  const traceContext = createTraceContext(input.parent);
  const startedAt = Date.now();
  const level = input.level ?? "info";

  input.logger[level](`${input.name}.started`, {
    trace_id: traceContext.traceId,
    span_id: traceContext.spanId,
    parent_span_id: traceContext.parentSpanId ?? null,
    ...input.attributes
  });
  emitSpan({
    type: "span.start",
    timestamp: new Date().toISOString(),
    trace_id: traceContext.traceId,
    span_id: traceContext.spanId,
    parent_span_id: traceContext.parentSpanId ?? null,
    name: input.name,
    attributes: input.attributes
  });

  return {
    traceContext,
    end: (error?: unknown) => {
      const durationMs = Date.now() - startedAt;
      if (error) {
        input.logger.error(`${input.name}.failed`, {
          trace_id: traceContext.traceId,
          span_id: traceContext.spanId,
          parent_span_id: traceContext.parentSpanId ?? null,
          duration_ms: durationMs,
          error: serializeError(error),
          ...input.attributes
        });
      } else {
        input.logger.info(`${input.name}.completed`, {
          trace_id: traceContext.traceId,
          span_id: traceContext.spanId,
          parent_span_id: traceContext.parentSpanId ?? null,
          duration_ms: durationMs,
          ...input.attributes
        });
      }
      emitSpan({
        type: "span.end",
        timestamp: new Date().toISOString(),
        trace_id: traceContext.traceId,
        span_id: traceContext.spanId,
        parent_span_id: traceContext.parentSpanId ?? null,
        name: input.name,
        duration_ms: durationMs,
        attributes: input.attributes,
        ...(error ? { error: serializeError(error) } : {})
      });
    }
  };
}
