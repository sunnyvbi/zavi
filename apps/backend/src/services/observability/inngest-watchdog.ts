
import { fleetSweepClient } from "@/services/tenant-client";
import { alert } from "@/services/logging/alert";
import { INTERACTIVE_TRIGGERS } from "@/services/agents/run-lane";

export const DOCTOR_OK_MAX_AGE_MIN = 75;
export const QUEUED_MAX_AGE_MIN = 15;
const TICK_MS = 5 * 60_000;
const REPAGE_MS = 60 * 60_000;
const MIN = 60_000;

export type WatchdogFacts = {
  now: number;
  lastDoctorOkAt: string | null;
  stuckQueued: Array<{ id: string; tenant_id: string; enqueued_at: string }>;
};

export type WatchdogFinding = {
  kind: "doctor_silent" | "runs_stuck_queued";
  msg: string;
  subjectDetail: string;
  detail: string;
};

const DASHBOARD_HINT =
  "Check the Inngest dashboard (Apps -> praxis): the app URL must be https://jobs.zaviagent.com/api/inngest. " +
  "If it is wrong, restart the worker (it re-syncs on boot) or PUT https://jobs.zaviagent.com/api/inngest once, on purpose.";

export function evaluateWatchdog(f: WatchdogFacts): WatchdogFinding[] {
  const out: WatchdogFinding[] = [];

  const okAgeMin = f.lastDoctorOkAt == null ? null : (f.now - Date.parse(f.lastDoctorOkAt)) / MIN;
  if (okAgeMin == null || !Number.isFinite(okAgeMin) || okAgeMin > DOCTOR_OK_MAX_AGE_MIN) {
    const age = okAgeMin == null || !Number.isFinite(okAgeMin) ? `over ${DOCTOR_OK_MAX_AGE_MIN}` : String(Math.round(okAgeMin));
    out.push({
      kind: "doctor_silent",
      msg: `no ok doctor.inngest check in ${age} min: Inngest may not be running jobs`,
      subjectDetail: `Inngest silent ${age} min`,
      detail: `The hourly doctor cron (an Inngest function) has not logged an ok ping/pong in ${age} minutes. ${DASHBOARD_HINT}`,
    });
  }

  if (f.stuckQueued.length > 0) {
    const oldest = Math.max(...f.stuckQueued.map((r) => (f.now - Date.parse(r.enqueued_at)) / MIN));
    const tenants = new Set(f.stuckQueued.map((r) => r.tenant_id)).size;
    const n = f.stuckQueued.length;
    out.push({
      kind: "runs_stuck_queued",
      msg: `${n} interactive run(s) queued over ${QUEUED_MAX_AGE_MIN} min across ${tenants} tenant(s), oldest ${Math.round(oldest)} min`,
      subjectDetail: `${n} runs queued, oldest ${Math.round(oldest)} min`,
      detail:
        `Runs a person is waiting on are not being picked up. Run ids: ${f.stuckQueued.map((r) => r.id).join(", ")}. ` +
        DASHBOARD_HINT,
    });
  }
  return out;
}

type Db = ReturnType<typeof fleetSweepClient>;

export async function readWatchdogFacts(db: Db, now: number): Promise<WatchdogFacts | null> {
  const [doctor, queued] = await Promise.all([
    db
      .from("praxis_logs")
      .select("created_at")
      .eq("source", "praxis-doctor.cron")
      .eq("code", "doctor.inngest")
      .eq("level", "info")
      .like("message", "ping/pong round-trip ok%")
      .gte("created_at", new Date(now - 2 * 60 * MIN).toISOString())
      .order("created_at", { ascending: false })
      .limit(1),
    db
      .from("agent_runs")
      .select("id, tenant_id, enqueued_at")
      .eq("status", "queued")
      .in("trigger", [...INTERACTIVE_TRIGGERS])
      .is("batch_id", null)
      .lt("enqueued_at", new Date(now - QUEUED_MAX_AGE_MIN * MIN).toISOString())
      .gte("enqueued_at", new Date(now - 24 * 60 * MIN).toISOString())
      .order("enqueued_at", { ascending: true })
      .limit(20),
  ]);
  if (doctor.error || queued.error) {
    console.warn(
      `[inngest-watchdog] tick skipped, read failed: ${(doctor.error ?? queued.error)?.message ?? "unknown"}`,
    );
    return null;
  }
  const row = (doctor.data ?? [])[0] as { created_at: string } | undefined;
  return {
    now,
    lastDoctorOkAt: row?.created_at ?? null,
    stuckQueued: (queued.data ?? []) as WatchdogFacts["stuckQueued"],
  };
}

export type WatchdogDeps = {
  db?: Db;
  page?: typeof alert;
  nowFn?: () => number;
};

export async function runWatchdogTick(
  lastPaged: Map<WatchdogFinding["kind"], number>,
  deps: WatchdogDeps = {},
): Promise<WatchdogFinding[]> {
  const now = (deps.nowFn ?? Date.now)();
  const db = deps.db ?? fleetSweepClient("inngest watchdog: fleet-wide stuck-run and doctor heartbeat read");
  const page = deps.page ?? alert;
  const facts = await readWatchdogFacts(db, now);
  if (!facts) return [];
  const findings = evaluateWatchdog(facts);
  const active = new Set(findings.map((f) => f.kind));
  for (const kind of [...lastPaged.keys()]) if (!active.has(kind)) lastPaged.delete(kind);
  const paged: WatchdogFinding[] = [];
  for (const f of findings) {
    const last = lastPaged.get(f.kind);
    if (last != null && now - last < REPAGE_MS) continue;
    lastPaged.set(f.kind, now);
    paged.push(f);
    await page({
      source: "inngest-watchdog",
      code: `inngest.watchdog.${f.kind}`,
      msg: f.msg,
      email: {
        dedupeKey: `inngest-watchdog:${f.kind}:${Math.floor(now / REPAGE_MS)}`,
        subjectDetail: f.subjectDetail,
        detail: f.detail,
      },
    });
  }
  return paged;
}

let timer: NodeJS.Timeout | null = null;

export function startInngestWatchdog(env: NodeJS.ProcessEnv = process.env): void {
  if (timer || env.INNGEST_WATCHDOG === "0") return;
  const lastPaged = new Map<WatchdogFinding["kind"], number>();
  const tick = () => {
    runWatchdogTick(lastPaged).catch((e) =>
      console.error("[inngest-watchdog] tick error (non-fatal):", (e as Error).message),
    );
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}
