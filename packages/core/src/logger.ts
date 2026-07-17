import { fileURLToPath } from "node:url";
import pino from "pino";

// @ve/core depends on nothing internal (doc 00 §4), so it cannot import @ve/config —
// level/env come straight from the process env here, and only here.

// pino transports load in a worker thread that resolves modules from pino's own
// location — under bun's isolated node_modules that misses pino-pretty. Resolve it
// to an absolute path from this package's context instead; fall back to JSON logs.
function prettyTargetPath(): string | null {
  try {
    return fileURLToPath(import.meta.resolve("pino-pretty"));
  } catch {
    return null;
  }
}

export function makeLogger(app: string, opts: { level?: string } = {}) {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const appEnv = process.env.APP_ENV;
  const wantPretty = appEnv === "development" || appEnv === undefined;
  const target = wantPretty ? prettyTargetPath() : null;
  return pino({
    level,
    base: { app },
    ...(target
      ? {
          transport: {
            target,
            options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
          },
        }
      : {}),
  });
}

export type Logger = ReturnType<typeof makeLogger>;
