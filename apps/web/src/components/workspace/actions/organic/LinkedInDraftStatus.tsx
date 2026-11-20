"use client";
import type { ActionItem } from "../types";

export function LinkedInDraftStatus({ action: a, canPublish }: { action: ActionItem; canPublish: boolean }) {
  if (a.channel_slug !== "linkedin_organic" || a.status !== "pending" || !!a.exec_status || a.action_type === "reply") return null;
  const date = typeof a.proposed_at === "string" ? new Date(a.proposed_at) : null;
  const drafted = date && Number.isFinite(date.getTime()) ? date : null;
  const older = drafted && Date.now() - drafted.getTime() > 14 * 86_400_000;
  return <div data-testid="linkedin-draft-status" className="mb-3 space-y-1 text-sm text-ca-secondary">
    <p>{a.staged_draft_id || a.run_id === null ? "Awaiting approval" : "Draft ready"} · {canPublish ? "Nothing publishes until you press Post." : "Open in LinkedIn to publish manually, or connect a publishing profile in Settings."}</p>
    {drafted && <p>Drafted <time dateTime={drafted.toISOString()}>{drafted.toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric",timeZone:"UTC"})}</time>.{older ? " Review this older draft against your current company facts before posting." : ""}</p>}
  </div>;
}
