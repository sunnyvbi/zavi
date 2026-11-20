
import type { MetaGeoPlace, ReplaceAdSetGeoBody } from "./replace_ad_set_geo";
import { replaceAdSetGeoBodySchema } from "./replace_ad_set_geo";

const CLASS = "meta_ads.replace_ad_set_geo_review";

const keyOf = (x: { type: string; key: string }) => `${x.type}:${x.type === "country" ? x.key.toUpperCase() : x.key}`;
const sameKeys = (a: ReadonlyArray<{ type: string; key: string }>, b: ReadonlyArray<{ type: string; key: string }>) =>
  [...new Set(a.map(keyOf))].sort().join(",") === [...new Set(b.map(keyOf))].sort().join(",");

export function locationUndoBody(p: ReplaceAdSetGeoBody, liveBefore: ReadonlyArray<MetaGeoPlace>, afterFingerprint: string | null): ReplaceAdSetGeoBody | null {
  if (p.origin !== "zavi_location_proposal" || !afterFingerprint || liveBefore.length === 0 || !p.before_places?.length) return null;
  if (!sameKeys(liveBefore, p.before_places)) return null;
  const named = liveBefore.map((x) => ({ ...x, name: p.before_places!.find((b) => keyOf(b) === keyOf(x))?.name ?? x.name }));
  const r = replaceAdSetGeoBodySchema.safeParse({
    ad_set_id: p.ad_set_id,
    places: named,
    before_names: p.places.map((x) => x.name ?? x.key),
    expected_fingerprint: afterFingerprint,
    ...(p.name ? { name: p.name } : {}),
    rationale: "Put back the places this ad set showed in before Zavi's location change.",
    over_cap: true,
    origin: "zavi_location_undo",
    ...(p.budget_daily ? { budget_daily: p.budget_daily } : {}),
    ...(p.budget_currency ? { budget_currency: p.budget_currency } : {}),
  });
  return r.success ? r.data : null;
}

export const UNDO_FOLLOWS = "A card to put the old places back follows.";
export const UNDO_NOT_FILED = "Zavi could not file the card to put the old places back; change them in Ads Manager if you need to.";

const RECEIPT_MAX = 200;

const withUndoLine = (text: string, line: string, max = Infinity) => {
  let base = text.split(UNDO_FOLLOWS).join("").split(UNDO_NOT_FILED).join("").replace(/\s+/g, " ").trim();
  const room = max - line.length - 1;
  if (base.length > room) base = `${base.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${base} ${line}`.trim();
};

export const undoReceiptLine = (base: string, status: "filed" | "not_filed") =>
  withUndoLine(base, status === "filed" ? UNDO_FOLLOWS : UNDO_NOT_FILED, RECEIPT_MAX);

export function withUndoStatus(result: Record<string, unknown>, status: "filed" | "not_filed"): Record<string, unknown> {
  const line = status === "filed" ? UNDO_FOLLOWS : UNDO_NOT_FILED;
  const { undo_not_filed: _u, ...rest } = result;
  const receipt = result.receipt && typeof result.receipt === "object" && !Array.isArray(result.receipt) ? (result.receipt as Record<string, unknown>) : {};
  return {
    ...rest,
    notice: withUndoLine(typeof result.notice === "string" ? result.notice : "", line),
    receipt: { ...receipt, line: withUndoLine(typeof receipt.line === "string" ? receipt.line : "", line, RECEIPT_MAX) },
    ...(status === "not_filed" ? { undo_not_filed: true } : {}),
  };
}

export type UndoDeps = {
  record: typeof import("@/services/channels/exec-actions").recordChannelExecAction;
  markUndo: (tenant_id: string, action_id: string, status: "filed" | "not_filed") => Promise<void>;
};

const liveDeps = async (): Promise<UndoDeps> => ({
  record: (await import("@/services/channels/exec-actions")).recordChannelExecAction,
  markUndo: async (tenant_id, action_id, status) => {
    const { asTenantId, tenantClient } = await import("@/services/tenant-client");
    const db = tenantClient(asTenantId(tenant_id));
    const { data, error: readErr } = await db.from("channel_actions").select("exec_result").eq("id", action_id).maybeSingle();
    if (readErr) throw new Error(`could not read card ${action_id}: ${readErr.message}`);
    const r = ((data as { exec_result?: Record<string, unknown> } | null)?.exec_result ?? {}) as Record<string, unknown>;
    if (status === "filed" && r.undo_not_filed !== true) return;
    const next = withUndoStatus(r, status);
    const { error: writeErr } = await db.from("channel_actions").update({ exec_result: next }).eq("id", action_id);
    if (writeErr) throw new Error(`could not update card ${action_id}: ${writeErr.message}`);
  },
});

export async function fileLocationUndoAfterSettle(tenant_id: string, action_id: string, run_id: string | null, raw: unknown, deps?: UndoDeps): Promise<"filed" | "skipped" | "not_filed"> {
  const d = deps ?? (await liveDeps());
  const parsed = replaceAdSetGeoBodySchema.safeParse(raw);
  if (!parsed.success || parsed.data.origin !== "zavi_location_undo" || !run_id) {
    await d.markUndo(tenant_id, action_id, "not_filed");
    return parsed.success && parsed.data.origin === "zavi_location_undo" ? "not_filed" : "skipped";
  }
  const body = parsed.data;
  let status: "filed" | "not_filed";
  try {
    const { buildMetaExecCardBody } = await import("./_exec-action");
    const { title, card } = buildMetaExecCardBody(CLASS, body);
    const out = await d.record(
      {
        tenantId: tenant_id,
        runId: run_id,
        channelSlug: "meta_ads",
        execClass: CLASS,
        execPayload: body as unknown as Record<string, unknown>,
        actionType: "update_ad",
        title,
        body: card,
      },
      undefined,
      { enabled: () => false, cgoDoor: false },
    );
    status = out.kept ? "not_filed" : "filed";
  } catch (e) {
    console.warn(`[location-undo] ${tenant_id}/${body.ad_set_id}: undo card not filed: ${(e as Error).message}`);
    status = "not_filed";
  }
  await d.markUndo(tenant_id, action_id, status);
  return status;
}
