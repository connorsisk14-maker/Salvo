export type StructuredLogLevel = "debug" | "info" | "warn" | "error";
type StructuredLogTarget = "stdout" | "stderr" | "split";
type StructuredLogFields = Record<string, unknown>;

const LOG_LEVEL_PRIORITIES: Record<StructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function normalizeLogLevel(input: string | undefined): StructuredLogLevel {
  if (input === "debug" || input === "info" || input === "warn" || input === "error") {
    return input;
  }
  return "info";
}

function normalizeLogTarget(input: string | undefined): StructuredLogTarget {
  if (input === "stdout" || input === "stderr" || input === "split") {
    return input;
  }
  return "split";
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)])
    );
  }

  return value;
}

function serializeFields(fields: StructuredLogFields): StructuredLogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeValue(value)])
  );
}

function writeLine(level: StructuredLogLevel, line: string, target: StructuredLogTarget): void {
  if (target === "stdout") {
    process.stdout.write(line);
    return;
  }

  if (target === "stderr") {
    process.stderr.write(line);
    return;
  }

  if (level === "warn" || level === "error") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

export function createLogger(baseFields: StructuredLogFields) {
  const configuredLevel = normalizeLogLevel(process.env.SALVO_LOG_LEVEL);
  const configuredTarget = normalizeLogTarget(process.env.SALVO_LOG_TARGET);

  function log(level: StructuredLogLevel, message: string, fields: StructuredLogFields = {}): void {
    if (LOG_LEVEL_PRIORITIES[level] < LOG_LEVEL_PRIORITIES[configuredLevel]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      pid: process.pid,
      ...serializeFields(baseFields),
      ...serializeFields(fields)
    };

    writeLine(level, `${JSON.stringify(payload)}\n`, configuredTarget);
  }

  return {
    child(fields: StructuredLogFields) {
      return createLogger({
        ...baseFields,
        ...fields
      });
    },
    debug(message: string, fields?: StructuredLogFields) {
      log("debug", message, fields);
    },
    info(message: string, fields?: StructuredLogFields) {
      log("info", message, fields);
    },
    warn(message: string, fields?: StructuredLogFields) {
      log("warn", message, fields);
    },
    error(message: string, fields?: StructuredLogFields) {
      log("error", message, fields);
    }
  };
}
