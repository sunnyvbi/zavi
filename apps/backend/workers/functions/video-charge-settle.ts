import { serviceClient } from "@/services/supabase";
import { flushCharges, type PendingCharge } from "@/services/media-router/charge";
import { logEvent } from "@/services/logging/logEvent";
import type { VideoRenderTarget } from "@/services/launch-video/delivery-target";

type Sb = ReturnType<typeof serviceClient>;

export type StoredCharge = PendingCharge & { delivery?: VideoRenderTarget["kind"] };
export type PendingVideoJob = { tenant_id: string; run_id: string; meter_key: string; pending_charges: StoredCharge[] | null; updated_at?: string | null };
const VIDEO_KEY_SUFFIX = ":gen-video:0";
export const CHARGE_SETTLE_GRACE_MS = 30 * 60 * 1000;
export const CHARGE_SETTLE_ABANDON_MS = 24 * 60 * 60 * 1000;
export const CHARGE_SETTLE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const CHARGE_SETTLE_BATCH = 100;
export const CHARGE_SETTLE_MAX_PAGES = 10;

export async function clearPendingCharges(sb: Sb, run_id: string, meter_key: string): Promise<void> {
  try {
    await sb.from("generative_video_jobs").update({ pending_charges: null }).eq("run_id", run_id).eq("meter_key", meter_key);
  } catch {
    return;
  }
}

function owedCharges(job: PendingVideoJob): StoredCharge[] {
  if (!job.meter_key.endsWith(VIDEO_KEY_SUFFIX)) return [];
  const base = job.meter_key.slice(0, -VIDEO_KEY_SUFFIX.length);
  return (job.pending_charges ?? []).filter((c) => c && typeof c.key === "string" && c.key.startsWith(`${base}:`) && c.tenant_id === job.tenant_id);
}

async function alertUnsettledVideoCharge(job: PendingVideoJob, items: number): Promise<void> {
  try {
    const { alert } = await import("@/services/logging/alert");
    await alert({
      source: "workers.generate_video",
      code: "video_charge_unsettled",
      tenant_id: job.tenant_id,
      msg: `A delivered video is not charged yet: tenant ${job.tenant_id}, run ${job.run_id}, ${items} item(s). It stays in generative_video_jobs.pending_charges and settle-video-charges retries it every hour.`,
      email: { dedupeKey: `video_charge_unsettled:${job.run_id}`, subjectDetail: "delivered video not charged" },
    });
  } catch {
    return;
  }
}

export async function settleRecordedVideoCharges(sb: Sb, job: PendingVideoJob): Promise<"nothing" | "already" | "settled"> {
  const owed = owedCharges(job).filter((c) => c.cost_usd > 0);
  if (owed.length === 0) {
    await clearPendingCharges(sb, job.run_id, job.meter_key);
    return "nothing";
  }
  const ledger = await sb
    .from("tenant_credit_ledger")
    .select("media_key")
    .eq("tenant_id", job.tenant_id)
    .eq("kind", "media")
    .in(
      "media_key",
      owed.map((c) => c.key),
    );
  if (ledger.error) throw new Error(`charge settle: ledger read failed: ${ledger.error.message}`);
  const charged = new Set(((ledger.data ?? []) as Array<{ media_key: string }>).map((r) => r.media_key));
  if (owed.every((c) => charged.has(c.key))) {
    await clearPendingCharges(sb, job.run_id, job.meter_key);
    return "already";
  }
  try {
    await flushCharges(owed.map((c) => ({ tenant_id: job.tenant_id, run_id: job.run_id, key: c.key, cost_usd: c.cost_usd, task: c.task, model: c.model })));
  } catch (e) {
    await alertUnsettledVideoCharge(job, owed.length);
    throw e;
  }
  void logEvent({ level: "warn", source: "workers.generate_video", code: "video_charge_repaired", tenant_id: job.tenant_id, run_id: job.run_id });
  await clearPendingCharges(sb, job.run_id, job.meter_key);
  return "settled";
}

export async function settleDeliveredVideoCharges(sb: Sb, tenant_id: string, run_id: string): Promise<"nothing" | "already" | "settled"> {
  const row = await sb
    .from("generative_video_jobs")
    .select("tenant_id, run_id, meter_key, pending_charges")
    .eq("run_id", run_id)
    .eq("meter_key", `${run_id}${VIDEO_KEY_SUFFIX}`)
    .maybeSingle<PendingVideoJob>();
  if (row.error) throw new Error(`charge settle: job read failed: ${row.error.message}`);
  if (!row.data?.pending_charges || row.data.tenant_id !== tenant_id) return "nothing";
  return settleRecordedVideoCharges(sb, row.data);
}

const CARD_RENDER_KEY = /^ca-([0-9a-f-]{36})-([0-9a-f-]{36})$/i;

async function recordedVideoDelivered(sb: Sb, job: PendingVideoJob): Promise<boolean> {
  const base = job.meter_key.slice(0, -VIDEO_KEY_SUFFIX.length);
  const card = CARD_RENDER_KEY.exec(base);
  const delivery = (job.pending_charges ?? []).find((c) => c?.delivery)?.delivery ?? (card ? "channel_action" : null);
  if (delivery === "channel_action") {
    if (!card) return false;
    const row = await sb
      .from("channel_actions")
      .select("exec_status, exec_claim_id")
      .eq("id", card[1])
      .eq("tenant_id", job.tenant_id)
      .maybeSingle<{ exec_status: string | null; exec_claim_id: string | null }>();
    if (row.error) throw new Error(`charge settle: card read failed: ${row.error.message}`);
    return row.data?.exec_status === "executed" && row.data.exec_claim_id === card[2];
  }
  if (delivery !== "chat" && delivery !== "slack") return false;
  let q = sb.from("run_artifacts").select("id").eq("tenant_id", job.tenant_id).eq("run_id", job.run_id).like("mime", "video/%");
  if (delivery === "slack") q = q.eq("slack_delivered", true);
  const hit = await q.limit(1);
  if (hit.error) throw new Error(`charge settle: delivery read failed: ${hit.error.message}`);
  return (hit.data ?? []).length > 0;
}

export type ChargeSweepResult = { checked: number; settled: number; already: number; waiting: number; abandoned: number; failed: number };

export async function settleUnchargedVideos(sb: Sb, now: number = Date.now()): Promise<ChargeSweepResult> {
  const out: ChargeSweepResult = { checked: 0, settled: 0, already: 0, waiting: 0, abandoned: 0, failed: 0 };
  const expired = await sb
    .from("generative_video_jobs")
    .select("run_id")
    .not("pending_charges", "is", null)
    .like("meter_key", `%${VIDEO_KEY_SUFFIX}`)
    .lt("updated_at", new Date(now - CHARGE_SETTLE_LOOKBACK_MS).toISOString())
    .limit(1);
  if (!expired.error && (expired.data ?? []).length > 0) {
    void logEvent({ level: "error", source: "workers.generate_video", code: "video_charge_settle_expired", message: "a recorded video charge is older than the settle lookback and was never settled" });
  }
  let cursor = new Date(now - CHARGE_SETTLE_LOOKBACK_MS).toISOString();
  const jobs: PendingVideoJob[] = [];
  for (let page = 0; page < CHARGE_SETTLE_MAX_PAGES; page++) {
    const rows = await sb
      .from("generative_video_jobs")
      .select("tenant_id, run_id, meter_key, pending_charges, updated_at")
      .not("pending_charges", "is", null)
      .like("meter_key", `%${VIDEO_KEY_SUFFIX}`)
      .lt("updated_at", new Date(now - CHARGE_SETTLE_GRACE_MS).toISOString())
      .gte("updated_at", cursor)
      .order("updated_at", { ascending: true })
      .limit(CHARGE_SETTLE_BATCH);
    if (rows.error) throw new Error(`charge settle: pending read failed: ${rows.error.message}`);
    const batch = ((rows.data ?? []) as PendingVideoJob[]).filter((j) => !jobs.some((x) => x.run_id === j.run_id && x.meter_key === j.meter_key));
    jobs.push(...batch);
    if ((rows.data ?? []).length < CHARGE_SETTLE_BATCH || batch.length === 0) break;
    cursor = batch[batch.length - 1].updated_at ?? cursor;
  }
  for (const job of jobs) {
    out.checked++;
    try {
      if (!(await recordedVideoDelivered(sb, job))) {
        if (Date.parse(job.updated_at ?? "") < now - CHARGE_SETTLE_ABANDON_MS) {
          await clearPendingCharges(sb, job.run_id, job.meter_key);
          out.abandoned++;
        } else out.waiting++;
        continue;
      }
      const r = await settleRecordedVideoCharges(sb, job);
      if (r === "settled") out.settled++;
      else out.already++;
    } catch (e) {
      out.failed++;
      console.error(`[settle-video-charges] run ${job.run_id}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function runVideoChargeSettleSlot(now: Date, settle: (sb: Sb, nowMs: number) => Promise<ChargeSweepResult> = settleUnchargedVideos): Promise<ChargeSweepResult | "skipped" | "failed"> {
  if (now.getUTCMinutes() >= 10) return "skipped";
  try {
    return await settle(serviceClient(), now.getTime());
  } catch (e) {
    void logEvent({ level: "error", source: "workers.generate_video", code: "video_charge_settle_failed", error: e });
    return "failed";
  }
}
