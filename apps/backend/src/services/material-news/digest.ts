
import { tenantClient, tenantRpc, asTenantId } from "@/services/tenant-client";
import { sendMaterialNewsDigestEmail } from "@/email/sendMaterialNewsDigest";
import { SCORE_FLOOR } from "./scan";

export const MAX_FINDINGS_PER_EMAIL = 5;

export type DigestOutcome =
  | { status: "skipped"; reason: string }
  | { status: "sent"; count: number; findings: number };

type PendingFinding = {
  id: string;
  headline: string;
  why: string;
  normalized_url: string;
  score: number;
};

async function audit(
  tenant_id: string,
  row: { skip_reason?: string; score?: number },
): Promise<void> {
  await tenantClient(asTenantId(tenant_id))
    .from("material_news_emitted")
    .insert({
      phase: "digest",
      skip_reason: row.skip_reason ?? null,
      score: row.score ?? null,
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

export async function sendTenantDigest(tenant: {
  id: string;
  display_name?: string | null;
}): Promise<DigestOutcome> {
  const tenant_id = tenant.id;
  const tid = asTenantId(tenant_id);
  const tc = tenantClient(tid);

  const { data: rows, error: readErr } = await tc
    .from("news_findings")
    .select("id, headline, why, normalized_url, score")
    .is("last_emailed_at", null)
    .gte("score", SCORE_FLOOR)
    .order("score", { ascending: false })
    .limit(MAX_FINDINGS_PER_EMAIL);
  if (readErr) {
    return { status: "skipped", reason: `findings read failed: ${readErr.message}` };
  }
  const pending = (rows ?? []) as PendingFinding[];
  if (pending.length === 0) {
    return { status: "skipped", reason: "no_fresh_findings" };
  }

  const send_day = new Date().toISOString().slice(0, 10);
  const { data: claimRows, error: claimErr } = await tenantRpc(tid, "claim_news_digest_send", {
    p_send_day: send_day,
  });
  if (claimErr) {
    const msg = claimErr.message || "";
    if (msg.includes("cooldown")) {
      await audit(tenant_id, { skip_reason: "cooldown" });
      return { status: "skipped", reason: "cooldown" };
    }
    if (msg.includes("already_finalized")) {
      return { status: "skipped", reason: "already_finalized_today" };
    }
    return { status: "skipped", reason: `claim failed: ${msg}` };
  }
  const claim = Array.isArray(claimRows)
    ? (claimRows[0] as { id: string; is_fresh: boolean } | undefined)
    : (claimRows as { id: string; is_fresh: boolean } | null);
  if (!claim) {
    return { status: "skipped", reason: "claim_no_row" };
  }
  if (!claim.is_fresh) {
    await audit(tenant_id, { skip_reason: "reclaim_skip" });
    return { status: "skipped", reason: "reclaim_in_flight" };
  }
  const deliveryId = claim.id;

  let outcome: Awaited<ReturnType<typeof sendMaterialNewsDigestEmail>>;
  try {
    outcome = await sendMaterialNewsDigestEmail({
      tenant_id,
      tenantName: tenant.display_name ?? undefined,
      findings: pending.map((f) => ({
        headline: f.headline,
        why: f.why,
        url: f.normalized_url,
      })),
    });
  } catch (e) {
    const { error: mErr } = await tenantRpc(tid, "mark_news_digest_sent", { p_id: deliveryId, p_status: "failed" });
    if (mErr) {
      console.error(
        `[material-news-digest] tenant=${tenant_id} mark_failed errored after send-setup throw: ${mErr.message} (delivery stays 'claimed'; may suppress this tenant up to 7d)`,
      );
    }
    await audit(tenant_id, { skip_reason: "send_threw" });
    return { status: "skipped", reason: `send_threw: ${(e as Error).message}` };
  }

  if (outcome.sent) {
    const { error: markErr } = await tenantRpc(tid, "mark_news_digest_sent", {
      p_id: deliveryId,
      p_status: "sent",
      p_finding_ids: pending.map((f) => f.id),
    });
    if (markErr) {
      console.error(
        `[material-news-digest] tenant=${tenant_id} finalize FAILED after send: ${markErr.message} (delivery stays 'claimed'; cooldown blocks 7d)`,
      );
      await tc
        .from("news_findings")
        .update({ last_emailed_at: new Date().toISOString() })
        .is("last_emailed_at", null)
        .in(
          "id",
          pending.map((f) => f.id),
        )
        .then(
          () => undefined,
          () => undefined,
        );
    }
    await audit(tenant_id, { skip_reason: "sent" });
    return { status: "sent", count: outcome.count, findings: pending.length };
  }

  const { error: mErr } = await tenantRpc(tid, "mark_news_digest_sent", { p_id: deliveryId, p_status: "failed" });
  if (mErr) {
    console.error(
      `[material-news-digest] tenant=${tenant_id} mark_failed errored: ${mErr.message} (delivery stays 'claimed'; may suppress this tenant up to 7d)`,
    );
  }
  await audit(tenant_id, { skip_reason: "send_failed" });
  return { status: "skipped", reason: `send_failed: ${outcome.reason}` };
}
