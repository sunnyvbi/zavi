import { asTenantId, tenantClient } from "@/services/tenant-client";
import { parseMoveTest, readoutDay } from "./cgo-tests";

const CGO_CARD_CLASS = "cgo.dispatch-specialist";
const DAY = 86_400_000;

export type TestEnd = {
  decision_id: string;
  channel: string | null;
  ends_on: string;
};

export const testEndInstant = (endsOn: string) => `${endsOn}T00:00:00Z`;
export const testEndUnix = (endsOn: string) => Math.floor(Date.parse(testEndInstant(endsOn)) / 1000);
export const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

export function earlierEndDay(bodyEnd: string | null | undefined, testEndsOn: string): string {
  return typeof bodyEnd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bodyEnd) && bodyEnd < testEndsOn ? bodyEnd : testEndsOn;
}

export function earlierEndIso(bodyEnd: string | null | undefined, testEndsOn: string): string {
  const test = Date.parse(testEndInstant(testEndsOn));
  const own = typeof bodyEnd === "string" ? Date.parse(bodyEnd) : NaN;
  return Number.isFinite(own) && own < test ? (bodyEnd as string) : new Date(test).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function metaTestEndTime(bodyEnd: string | null | undefined, testEndsOn: string): string {
  const test = `${testEndsOn}T00:00:00+00:00`;
  const own = typeof bodyEnd === "string" ? Date.parse(bodyEnd) : NaN;
  return Number.isFinite(own) && own < Date.parse(test) ? (bodyEnd as string) : test;
}

export function endWithinTest(readBack: string | number | null | undefined, testEndsOn: string): boolean {
  const t = typeof readBack === "number" ? readBack * 1000 : typeof readBack === "string" ? Date.parse(readBack.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
  return Number.isFinite(t) && t <= Date.parse(testEndInstant(testEndsOn));
}

export function googleEndWithinTest(endDateTime: string | null | undefined, endDate: string): boolean {
  const day = typeof endDateTime === "string" ? endDateTime.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= dayBefore(endDate);
}

export const TEST_SPEND_CREATES: Readonly<Record<string, "end_written" | "no_end">> = {
  "google_ads.create_campaign": "end_written",
  "meta_ads.launch_campaign": "end_written",
  "tiktok_ads.create_launch": "end_written",
  "x_ads.create_campaign": "end_written",
  "chatgpt_ads.create_and_launch": "end_written",
  "meta_ads.create_ad_set": "no_end",
  "meta_ads.create_campaign": "no_end",
  "meta_ads.duplicate_ad_set": "end_written",
  "meta_ads.duplicate_campaign": "end_written",
  "reddit_ads.launch_campaign": "no_end",
  "linkedin_ads.create_campaign_bundle": "no_end",
  "linkedin_ads.launch_campaign": "no_end",
};

const NO_END_CHANNELS: ReadonlySet<string> = new Set(["youtube_ads", "reddit_ads", "linkedin_ads"]);

export function testCreateEndSupport(execClass: string, payload: unknown, test: Pick<TestEnd, "channel">, tiktokEndDates: boolean): "ok" | "no_end" {
  const cls = execClass.replace(/_review$/, "");
  const kind = TEST_SPEND_CREATES[cls];
  if (!kind) return "ok";
  if (kind === "no_end" || (test.channel != null && NO_END_CHANNELS.has(test.channel))) return "no_end";
  if (cls === "google_ads.create_campaign" && (payload as { channel_type?: unknown } | null)?.channel_type === "DEMAND_GEN") return "no_end";
  if (cls === "tiktok_ads.create_launch" && !tiktokEndDates) return "no_end";
  return "ok";
}

export async function cgoTestEndForRun(tenant_id: string, run_id: string | null | undefined, now: Date = new Date()): Promise<TestEnd | null> {
  if (!run_id) return null;
  const db = tenantClient(asTenantId(tenant_id));
  const r = await db
    .from("agent_runs")
    .select("source_decision_id, payload_source:payload->>source_decision_id")
    .eq("tenant_id", tenant_id)
    .eq("id", run_id)
    .maybeSingle<{ source_decision_id: string | null; payload_source: string | null }>();
  if (r.error) throw new Error(`test end: run read failed: ${r.error.message}`);
  const src = r.data?.source_decision_id ?? r.data?.payload_source ?? null;
  if (!src) return null;
  const d = await db
    .from("decisions")
    .select("id, emitted_at, decision_class, body")
    .eq("tenant_id", tenant_id)
    .eq("id", src)
    .maybeSingle<{ id: string; emitted_at: string; decision_class: string | null; body: Record<string, unknown> | null }>();
  if (d.error) throw new Error(`test end: order read failed: ${d.error.message}`);
  if (!d.data || d.data.decision_class !== CGO_CARD_CLASS || d.data.body?.dispatched_by !== "cgo") return null;
  const raw = d.data.body?.test;
  if (raw == null) return null;
  const test = parseMoveTest(raw);
  if (!test) throw new Error(`test end: the order's test could not be read (${src})`);
  const channel = typeof d.data.body?.target_agent_slug === "string" ? d.data.body.target_agent_slug : null;
  return { decision_id: d.data.id, channel, ends_on: readoutDay(d.data.emitted_at, test, now.toISOString()) };
}
