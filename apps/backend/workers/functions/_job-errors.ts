
import { logEvent } from "@/services/logging/logEvent";

export function logJobError(job: string, message: string, log: typeof logEvent = logEvent): Promise<void> {
  console.warn(message.startsWith("[") ? message : `[${job}] ${message}`);
  return log({ level: "error", source: job, code: `${job.replace(/-/g, "_")}_error`, message }).then(
    () => undefined,
    () => undefined,
  );
}

export function persistingLogger<L extends { warn: (msg: string) => void; error: (msg: string) => void }>(
  job: string,
  logger: L,
  log: typeof logEvent = logEvent,
): L {
  const keep = (msg: string) => void log({ level: "error", source: job, code: `${job.replace(/-/g, "_")}_error`, message: msg }).catch(() => undefined);
  return {
    ...logger,
    warn: (msg: string) => {
      logger.warn(msg);
      keep(msg);
    },
    error: (msg: string) => {
      logger.error(msg);
      keep(msg);
    },
  };
}
