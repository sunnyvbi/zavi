import { ZodError } from "zod";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { BULK_SEND_CLASS, hostOf, makeProposeCampaignTool, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { resolveEmailCampaignEmit } from "@/services/tools/email-campaign/_exec-action";
import { EMAIL_CARD_CAP_FULL, EMAIL_LINK_MAX, firstHttpsLink, topActionDef } from "@/services/channels/top-actions";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";
import type { EmailContent } from "@/services/email-templates/render";
import { PASTE_RUN_STAGE } from "./paste-run";

export const PASTE_CHANNEL = "email_marketing";
export { PASTE_RUN_STAGE };
export function pasteRationale(buttonUrl: string, fromBody: boolean): string {
  const target = fromBody ? `the first https link in your email, ${buttonUrl}` : `your website, ${buttonUrl}`;
  return `You wrote this email and pasted it in. Zavi kept your words as written, put your subject at the top as the heading, and added a Read more button that goes to ${target}. Check both in your test send.`;
}
export const PASTE_BUTTON_LABEL = "Read more";
const PARAGRAPH_MAX = 5_000;
const PARAGRAPHS_MAX = 20;

type Rail = "channel_actions" | "decisions";

export type PastedEmailInputs = {
  route: "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";
  list_id: string;
  pasted: { subject: string; preview_text?: string; body: string };
};

export type PasteDeps = {
  tool: Partial<ProposeCampaignDeps>;
  website: (tenantId: string) => Promise<string | null>;
  insertRun: (tenantId: string, now: Date) => Promise<string>;
  resolveCardEmit: typeof resolveEmailCampaignEmit;
  emitDecisionRpc: (tenantId: string, runId: string, decisionClass: string, body: unknown) => Promise<string>;
  now: () => Date;
};

export type PasteResult =
  | { ok: true; card: { rail: Rail; id: string }; link: string; route: PastedEmailInputs["route"]; versions: number }
  | { ok: false; code: string; message: string; wrote: boolean };

async function liveWebsite(tenantId: string): Promise<string | null> {
  const { getCompanyFacts } = await import("@/services/company/facts");
  return (await getCompanyFacts(tenantId)).website;
}

async function liveInsertRun(tenantId: string, now: Date): Promise<string> {
  const at = now.toISOString();
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_runs")
    .insert({
      agent_slug: PASTE_CHANNEL,
      channel_slug: PASTE_CHANNEL,
      agent_definition_hash: PASTE_RUN_STAGE,
      trigger: "manual",
      status: "success",
      enqueued_at: at,
      started_at: at,
      finished_at: at,
      parse_ok: true,
      cost_tokens: 0,
      cost_usd: 0,
      tool_calls: [],
      output_text: "The founder pasted an email they wrote (no model run).",
      payload: { stage: PASTE_RUN_STAGE },
    })
    .select("id");
  if (error) throw new Error(`email paste run: insert failed: ${error.message}`);
  const id = (data as Array<{ id?: string }> | null)?.[0]?.id;
  if (typeof id !== "string" || !id) throw new Error("email paste run: insert returned no id");
  return id;
}

async function liveEmitDecisionRpc(tenantId: string, runId: string, decisionClass: string, body: unknown): Promise<string> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "emit_decision", {
    p_agent_run_id: runId,
    p_decision_class: decisionClass,
    p_body: body as object,
  });
  if (error) throw new Error(`emit_decision failed (${decisionClass}): ${error.message}`);
  return data as string;
}

export const LIVE_PASTE_DEPS: PasteDeps = {
  tool: {},
  website: liveWebsite,
  insertRun: liveInsertRun,
  resolveCardEmit: resolveEmailCampaignEmit,
  emitDecisionRpc: liveEmitDecisionRpc,
  now: () => new Date(),
};

function cut(block: string): string[] {
  const out: string[] = [];
  let rest = block;
  while (rest.length > PARAGRAPH_MAX) {
    let at = -1;
    for (let k = PARAGRAPH_MAX; k > 0; k--) {
      if (/\s/.test(rest[k])) {
        at = k;
        break;
      }
    }
    if (at <= 0) at = PARAGRAPH_MAX;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function pastedParagraphs(body: string): string[] {
  const pieces = body
    .split(/\r?\n[ \t]*\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap(cut);
  if (pieces.length <= PARAGRAPHS_MAX) return pieces;
  const packed: string[] = [];
  for (const p of pieces) {
    const last = packed.length - 1;
    if (last >= 0 && packed[last].length + 2 + p.length <= PARAGRAPH_MAX) packed[last] = `${packed[last]}\n\n${p}`;
    else packed.push(p);
  }
  return packed;
}

export function websiteButtonUrl(website: string | null): string | null {
  const raw = website?.trim() ?? "";
  if (!raw) return null;
  if (/^https:\/\//i.test(raw) && firstHttpsLink(raw) === raw) return raw;
  const host = hostOf(raw);
  const url = host ? `https://${host}` : null;
  return url && url.length <= EMAIL_LINK_MAX ? url : null;
}

export function pastedContent(p: PastedEmailInputs["pasted"], buttonUrl: string): EmailContent {
  return {
    subject: p.subject,
    preview_text: p.preview_text ?? "",
    title: p.subject,
    paragraphs: pastedParagraphs(p.body),
    button: { label: PASTE_BUTTON_LABEL, url: buttonUrl },
  } as EmailContent;
}

const noLegacyRail: EmitDecisionFn = async () => {
  throw new ExpectedToolError("email_card_rail_missing", "Zavi could not find where this email card belongs, so nothing was filed. Try again.");
};

export async function filePastedEmail(tenantId: string, rawInputs: unknown, depsIn: Partial<PasteDeps> = {}): Promise<PasteResult> {
  const deps: PasteDeps = { ...LIVE_PASTE_DEPS, ...depsIn };
  const def = topActionDef(PASTE_CHANNEL, "new_email");
  if (!def?.checkProposal) throw new Error("email paste: the new_email action is not defined");
  const checkProposal = def.checkProposal;
  const parsed = def.inputs.safeParse(rawInputs);
  if (!parsed.success) {
    return { ok: false, code: "validation", message: parsed.error.issues.map((i) => `${i.path.join(".") || "inputs"}: ${i.message}`).join("; "), wrote: false };
  }
  const inputs = parsed.data as Partial<PastedEmailInputs> & Pick<PastedEmailInputs, "route" | "list_id">;
  if (!inputs.pasted) return { ok: false, code: "paste_required", message: "Paste the email you wrote.", wrote: false };
  const pasted = inputs.pasted;
  const bodyLink = firstHttpsLink(pasted.body);
  const buttonUrl = bodyLink ?? websiteButtonUrl(await deps.website(tenantId).catch(() => null));
  if (!buttonUrl) {
    return {
      ok: false,
      code: "email_button_link_missing",
      message: "Your email has no https link and this workspace has no website saved, so the email's button has nowhere to go. Add a link to the email and try again.",
      wrote: false,
    };
  }
  let wrote = false;
  let landed: Rail | null = null;
  const emit: EmitDecisionFn = async (decisionClass, body) => {
    if (!def.classes.includes(decisionClass)) {
      throw new ExpectedToolError("top_action_scope", "This email cannot be filed as that kind of card. Nothing was filed.");
    }
    const problem = checkProposal(inputs as Record<string, unknown>, decisionClass, body);
    if (problem) throw new ExpectedToolError("top_action_mismatch", problem);
    const bulk = decisionClass === BULK_SEND_CLASS;
    if (typeof (bulk ? deps.emitDecisionRpc : deps.resolveCardEmit) !== "function") return noLegacyRail(decisionClass, body);
    const runId = await deps.insertRun(tenantId, deps.now());
    if (bulk) {
      wrote = true;
      landed = "decisions";
      return deps.emitDecisionRpc(tenantId, runId, decisionClass, body);
    }
    const write = await deps.resolveCardEmit({ tenant_id: tenantId, run_id: runId, emit_decision: noLegacyRail });
    if (!write || write === noLegacyRail) return noLegacyRail(decisionClass, body);
    wrote = true;
    landed = "channel_actions";
    return write(decisionClass, body);
  };
  const ctx: ToolContext = { tenant_id: tenantId, log: () => {}, emit_decision: emit };
  const variants = [pastedContent(pasted, buttonUrl)];
  const rationale = pasteRationale(buttonUrl, bodyLink !== null);
  const args =
    inputs.route === "zavi_list"
      ? { route: inputs.route, list_id: inputs.list_id, variants, rationale }
      : { route: inputs.route, audience_id: inputs.list_id, variants, rationale };
  let out: { card?: { rail?: unknown; id?: unknown }; versions?: unknown };
  try {
    out = (await makeProposeCampaignTool(deps.tool).execute(ctx, args)) as typeof out;
  } catch (e) {
    if (e instanceof ExpectedToolError) return { ok: false, code: e.code, message: e.code === "email_card_cap_reached" ? EMAIL_CARD_CAP_FULL : e.message, wrote };
    if (e instanceof ZodError && !wrote) return { ok: false, code: "validation", message: "This list or email could not be read. Pick the list again and try again.", wrote };
    console.warn(`[email-cards/paste] ${(e as Error)?.message ?? String(e)}`);
    return {
      ok: false,
      code: "paste_failed",
      message: wrote
        ? "Zavi could not file this email just now. Check Email campaigns before trying again."
        : "Zavi could not file this email just now. Nothing was filed. Try again.",
      wrote,
    };
  }
  const rail: Rail = landed ?? (out.card?.rail === "channel_actions" ? "channel_actions" : "decisions");
  const id = String(out.card?.id ?? "");
  return {
    ok: true,
    card: { rail, id },
    link: `/workspace/email-cards/${rail}/${encodeURIComponent(id)}`,
    route: inputs.route,
    versions: typeof out.versions === "number" ? out.versions : 1,
  };
}
