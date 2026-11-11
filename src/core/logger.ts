export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  child: (fields: Record<string, unknown>) => Logger;
};

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  options: { level?: LogLevel; base?: Record<string, unknown>; write?: (line: string) => void } = {},
): Logger {
  const threshold = LEVELS[options.level ?? "info"];
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    const payload = { time: new Date().toISOString(), level, message, ...base, ...fields };
    write(JSON.stringify(payload));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) =>
      createLogger({
        ...(options.level ? { level: options.level } : {}),
        base: { ...base, ...fields },
        write,
      }),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
