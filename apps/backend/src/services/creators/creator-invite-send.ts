
import { sgSend } from "@/email/sendAuthEmail";
import { systemSender } from "@/email/system-identity";
import { renderCreatorInviteEmail } from "@/email/templates/creator-invite";
import {
  classifySendError,
  eligibleRows,
  inviteLinkBases,
  markSendFailed,
  reconcileLinks,
  recordSendAmbiguous,
  sendPreflight,
  stampInvite,
  type Eligibility,
  type InviteMode,
  type InviteRow,
} from "./creator-invites";

export type SendTally = {
  total: number;
  attempted: number;
  sent: number;
  rejected: number;
  unknown: number;
  changed: number;
  render_skipped: number;
};

export type SendRowEvent = {
  sheetRow: number | null;
  name: string;
  outcome: "sent" | "rejected" | "unknown" | "changed" | "render_skipped" | "record_failed";
  detail?: string;
};

export type InviteSendOptions = {
  batch: string;
  max: number;
  rows?: readonly number[];
  skipRows?: readonly number[];
  retry: boolean;
  includeInConversation: boolean;
  apply: boolean;
  acknowledgedNoGeo: boolean;
  env: Record<string, string | undefined>;
  delayMs?: number;
  preselected?: InviteRow[];
  onProgress?: (tally: SendTally) => void | Promise<void>;
  onRow?: (e: SendRowEvent) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type InviteSendResult = {
  mode: InviteMode;
  eligibleCount: number;
  toSend: InviteRow[];
  skipped: Eligibility["skipped"];
  problems: string[];
  tally: SendTally;
  stoppedReason: string | null;
  sender: { email: string; name: string };
  links: { web: string | null; api: string | null };
};

export function inviteUnsubscribeUrl(apiBase: string | null, token: string): string {
  return `${apiBase}/api/creators/invite/unsubscribe?t=${encodeURIComponent(token)}`;
}

export function inviteSignupUrl(webBase: string | null, signupToken?: string | null): string {
  const invite = signupToken ? `&invite=${encodeURIComponent(signupToken)}` : "";
  return `${webBase}/creators/apply?src=invite${invite}`;
}

export function inviteSignInUrl(webBase: string | null, signupToken?: string | null): string {
  const invite = signupToken ? `&invite=${encodeURIComponent(signupToken)}` : "";
  return `${webBase}/creators/login?src=invite_message${invite}`;
}

export function renderInvite(
  row: Pick<InviteRow, "display_name" | "unsub_token" | "signup_token">,
  links: { web: string | null; api: string | null },
) {
  return renderCreatorInviteEmail({
    name: row.display_name,
    unsubscribeUrl: inviteUnsubscribeUrl(links.api, row.unsub_token),
    signupUrl: inviteSignupUrl(links.web, row.signup_token),
    siteUrl: links.web ?? "",
  });
}

export const sheetRowOf = (r: InviteRow): number | null => (typeof r.source_meta?.sheet_row === "number" ? r.source_meta.sheet_row : null);

function errorText(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return `${code ? `${code} ` : ""}${msg}`.slice(0, 500);
}

export async function selectInviteRows(opts: Pick<InviteSendOptions, "batch" | "max" | "rows" | "skipRows" | "retry" | "includeInConversation" | "apply">): Promise<{ eligibleCount: number; toSend: InviteRow[]; skipped: Eligibility["skipped"] }> {
  if (opts.apply) await reconcileLinks();
  const { candidates, skipped } = await eligibleRows({
    batch: opts.batch,
    mode: opts.retry ? "retry" : "invite",
    rows: opts.rows,
    skipRows: opts.skipRows,
    includeInConversation: opts.includeInConversation,
  });
  const toSend = opts.rows?.length ? candidates : candidates.slice(0, opts.max);
  return { eligibleCount: candidates.length, toSend, skipped };
}

export async function runInviteSend(opts: InviteSendOptions): Promise<InviteSendResult> {
  const mode: InviteMode = opts.retry ? "retry" : "invite";
  const links = inviteLinkBases(opts.env);
  const sender = systemSender();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs ?? 600;

  const selected = opts.preselected
    ? { eligibleCount: opts.preselected.length, toSend: opts.preselected, skipped: [] as Eligibility["skipped"] }
    : await selectInviteRows(opts);
  const { toSend } = selected;

  const problems = sendPreflight({
    apply: opts.apply,
    acknowledgedNoGeo: opts.acknowledgedNoGeo,
    sendgridKey: opts.env.SYSTEM_SENDGRID_API_KEY,
    renderSample: toSend[0] ? () => void renderInvite(toSend[0], links) : null,
    linkBases: links,
  });

  const tally: SendTally = { total: toSend.length, attempted: 0, sent: 0, rejected: 0, unknown: 0, changed: 0, render_skipped: 0 };
  const result: InviteSendResult = { mode, eligibleCount: selected.eligibleCount, toSend, skipped: selected.skipped, problems, tally, stoppedReason: null, sender, links };

  if (problems.length && opts.apply) throw new Error(`Preflight failed. Nothing was stamped or sent: ${problems.join("; ")}`);
  if (!opts.apply) return result;

  for (const row of toSend) {
    const event: SendRowEvent = { sheetRow: sheetRowOf(row), name: row.display_name, outcome: "sent" };
    let stop = false;
    try {
      let mail: ReturnType<typeof renderInvite>;
      try {
        mail = renderInvite(row, links);
      } catch (e) {
        tally.render_skipped += 1;
        event.outcome = "render_skipped";
        event.detail = errorText(e);
        continue;
      }
      const stamped = await stampInvite(row.id, { includeInConversation: opts.includeInConversation, retry: opts.retry });
      if (!stamped) {
        tally.changed += 1;
        event.outcome = "changed";
        continue;
      }
      const unsub = inviteUnsubscribeUrl(links.api, row.unsub_token);
      try {
        await sgSend(row.email as string, mail.subject, mail.html, mail.text, sender, {
          customArgs: { creator_invite_id: row.id },
          headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        tally.sent += 1;
      } catch (e) {
        const verdict = classifySendError(e);
        event.detail = errorText(e);
        try {
          if (verdict.kind === "rejected") {
            tally.rejected += 1;
            event.outcome = "rejected";
            await markSendFailed(row.id, errorText(e));
          } else {
            tally.unknown += 1;
            event.outcome = "unknown";
            await recordSendAmbiguous(row.id, errorText(e));
          }
        } catch (writeErr) {
          event.outcome = "record_failed";
          event.detail = errorText(writeErr);
          result.stoppedReason = "a send failed and the failure could not be recorded; check that row by hand";
          stop = true;
        }
        if (!stop && verdict.stop) {
          result.stoppedReason = "this error is likely to hit every row; fix it, then re-run (retry failed for rejected rows)";
          stop = true;
        }
      }
    } finally {
      tally.attempted += 1;
      opts.onRow?.(event);
      await opts.onProgress?.({ ...tally });
    }
    if (stop) break;
    await sleep(delayMs);
  }
  return result;
}
