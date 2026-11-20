
import { existsSync } from "node:fs";
import { isTenantDisabled } from "@/services/tenants/disabled";

export const SCHEDULED_EVENT = "inngest/scheduled.timer";
const DEFAULT_PAUSE_FILE = "/tmp/praxis-background-paused";
export const CRON_DEFAULT_RETRIES = 1;
export const BACKGROUND_CRON_CONCURRENCY = 10;
export const BACKGROUND_CRON_KEY = '"praxis-background-crons"';
const MAX_CONCURRENCY_CONSTRAINTS = 2;

type Concurrency = number | Record<string, unknown> | Array<Record<string, unknown>> | undefined;

export function withSharedCronCap(existing: Concurrency): Concurrency {
  const list =
    existing === undefined ? [] : Array.isArray(existing) ? existing
      : typeof existing === "number" ? [{ limit: existing }] : [existing];
  if (list.length >= MAX_CONCURRENCY_CONSTRAINTS) return existing;
  return [...list, { scope: "env", key: BACKGROUND_CRON_KEY, limit: BACKGROUND_CRON_CONCURRENCY }];
}

export function isBackgroundPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PRAXIS_BACKGROUND_PAUSED === "1" || env.PRAXIS_BACKGROUND_PAUSED === "true") return true;
  try {
    return existsSync(env.PRAXIS_BACKGROUND_PAUSE_FILE || DEFAULT_PAUSE_FILE);
  } catch {
    return false;
  }
}

export const TENANT_DISABLED_EXEMPT = new Set([
  "setup-draft-refund-on-complete",
  "setup-draft-refund-on-fail",
  "memory-forget-purge",
]);

function eventTenantId(event: unknown): string | null {
  const tid = (event as { data?: { tenant_id?: unknown } } | undefined)?.data?.tenant_id;
  return typeof tid === "string" && tid ? tid : null;
}

type Trigger = { cron?: string; event?: string };

function firesHourly(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length >= 5 && fields[fields.length - 4] === "*";
}

function isPureCron(trigger: unknown): boolean {
  const list = (Array.isArray(trigger) ? trigger : [trigger]) as Trigger[];
  return list.length > 0 && list.every((t) => typeof t?.cron === "string");
}

function isFrequentPureCron(trigger: unknown): boolean {
  const list = (Array.isArray(trigger) ? trigger : [trigger]) as Trigger[];
  return list.length > 0 && list.every((t) => typeof t?.cron === "string" && firesHourly(t.cron));
}

type Handler = (ctx: {
  event?: { name?: string; data?: unknown };
  logger?: { info: (m: string) => void };
}) => unknown;

export function withBackgroundBrake<T extends { createFunction: (...args: never[]) => unknown }>(
  client: T,
): T {
  const original = client.createFunction.bind(client) as unknown as (
    opts: Record<string, unknown>,
    trigger: unknown,
    handler: Handler,
  ) => unknown;
  const wrapped = (opts: Record<string, unknown>, trigger: unknown, handler: Handler) => {
    let finalOpts = opts;
    if (isPureCron(trigger)) {
      finalOpts = { ...finalOpts, concurrency: withSharedCronCap(finalOpts.concurrency as Concurrency) };
    }
    if (isFrequentPureCron(trigger) && opts.retries === undefined) {
      finalOpts = { ...finalOpts, retries: CRON_DEFAULT_RETRIES };
    }
    const exempt = TENANT_DISABLED_EXEMPT.has(String(opts.id));
    const braked: Handler = async (ctx) => {
      if (ctx?.event?.name === SCHEDULED_EVENT && isBackgroundPaused()) {
        ctx.logger?.info(`${String(opts.id)}: skipped, background brake is on`);
        return { skipped: "background_paused" };
      }
      const tid = exempt ? null : eventTenantId(ctx?.event);
      if (tid && (await isTenantDisabled(tid, "open"))) {
        ctx.logger?.info(`${String(opts.id)}: skipped, tenant ${tid} is disabled`);
        return { skipped: "tenant_disabled" };
      }
      return handler(ctx);
    };
    return original(finalOpts, trigger, braked);
  };
  (client as unknown as { createFunction: typeof wrapped }).createFunction = wrapped;
  return client;
}
