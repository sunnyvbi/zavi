
type Trigger = { cron?: unknown; event?: unknown };

function triggersOf(fn: unknown): Trigger[] {
  const triggers = (fn as { opts?: { triggers?: unknown } } | null)?.opts?.triggers;
  return (Array.isArray(triggers) ? triggers : triggers ? [triggers] : []) as Trigger[];
}

const isCron = (t: Trigger) => t !== null && typeof t === "object" && "cron" in t;

function explicitDevMode(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "" || value.trim().toLowerCase() === "undefined") return undefined;
  try {
    new URL(value);
    return true;
  } catch {
    return ["true", "1"].includes(value.trim().toLowerCase());
  }
}

export function isLocalInngest(env: NodeJS.ProcessEnv = process.env): boolean {
  return explicitDevMode(env.INNGEST_DEV) ?? !env.INNGEST_SIGNING_KEY;
}

function withoutCron<T>(fn: T): T | null {
  const triggers = triggersOf(fn);
  if (!triggers.some(isCron)) return fn;
  const rest = triggers.filter((t) => !isCron(t));
  if (rest.length === 0) return null;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(fn)), fn);
  copy.opts = { ...(fn as { opts: object }).opts, triggers: rest };
  return copy as T;
}

export function eventOnlyInngestFunctions<T>(
  fns: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  if (!isLocalInngest(env) || env.INNGEST_LOCAL_CRONS === "1") return [...fns];
  return fns.map(withoutCron).filter((fn): fn is T => fn !== null);
}
