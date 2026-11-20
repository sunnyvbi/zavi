
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { ChannelRedo } from "@/services/channels/engine";
import { canCurrentUserReadRun } from "@/services/agents/runner";
import { listActionViewsForRun } from "@/services/channels/channel-actions";
import { topActionDef, topActionFormContext, type TopActionDef } from "@/services/channels/top-actions";
import { loadChannelRecipe, recipeExists } from "@/services/channels/recipe";
import { priceForJob } from "@/services/billing/job-prices";
import { isFlatJobPricingOn } from "@/services/billing/flat-pricing";
import { checkAgentTier, planUpgradeErrorBody } from "@/services/agents/entitlement";
import { startChannelRun } from "./run";

const StartBody = z.object({
  request_id: z.string().trim().min(8).max(200),
  inputs: z.record(z.string(), z.unknown()),
});

function defOf(req: Request, res: Response) {
  const slug = String(req.params.slug ?? "");
  const key = String(req.params.key ?? "");
  const def = topActionDef(slug, key);
  if (!def) {
    res.status(404).json({ error: { code: "unknown_top_action", message: "This channel has no such action." } });
    return null;
  }
  return { slug, key, def };
}

export async function startTopAction(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
    return;
  }
  const found = defOf(req, res);
  if (!found) return;
  if (!found.def.members && !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const body = StartBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "validation", message: "Check the form and try again." } });
    return;
  }
  const inputs = (found.def.clientInputs ?? found.def.inputs).safeParse(body.data.inputs);
  if (!inputs.success) {
    res.status(400).json({
      error: { code: "validation", message: inputs.error.issues.map((i) => `${i.path.join(".") || "inputs"}: ${i.message}`).join("; ") },
    });
    return;
  }
  const parsed = inputs.data as Record<string, unknown>;
  if (found.def.precheck) {
    const executor = recipeExists(found.slug) ? loadChannelRecipe(found.slug).meta.executor : found.slug;
    const tier = await checkAgentTier(auth.tenant_id, executor).catch(() => null);
    if (tier && !tier.allowed) {
      res.status(403).json(planUpgradeErrorBody(executor, tier.required_tier));
      return;
    }
    const refusal = await found.def.precheck(auth.tenant_id, parsed);
    if (refusal) {
      res.status(409).json({ error: { code: "top_action_unsupported", message: refusal } });
      return;
    }
  }
  if (found.def.owned && !found.def.owned(parsed, auth.tenant_id)) {
    res.status(400).json({ error: { code: "validation", message: "That file is not in this workspace. Upload it again." } });
    return;
  }
  let runInputs = parsed;
  let redo: ChannelRedo | undefined;
  let requestId = body.data.request_id;
  if (found.def.resolve) {
    const r = await found.def.resolve(parsed, auth.tenant_id);
    if ("refusal" in r) {
      res.status(409).json({ error: { code: "top_action_refused", message: r.refusal } });
      return;
    }
    runInputs = r.inputs;
    redo = r.redo;
    if (r.request_id) requestId = r.request_id;
    if (redo?.redo_of_action_id) {
      const recorded = await tenantRpc(asTenantId(auth.tenant_id), "set_channel_action", {
        p_action_id: redo.redo_of_action_id,
        p_status: "redo_requested",
        p_note: redo.note,
        p_snoozed_until: null,
        p_event_key: `redo_requested:${requestId}`,
        p_actor_user_id: auth.user_id,
      });
      const out = (recorded.data ?? {}) as { ok?: boolean };
      if (recorded.error || !out.ok) {
        res.status(409).json({ error: { code: "top_action_refused", message: "This pick was already used. Refresh the page." } });
        return;
      }
    }
  }
  await startChannelRun(res, auth, found.slug, {
    requestId,
    topAction: { key: found.key, inputs: runInputs, instruction: found.def.instruction(runInputs), by: auth.user_id },
    redo,
  });
}

export async function topActionBilledCredits(
  slug: string,
  key: string,
  def: TopActionDef,
  flatOn: () => Promise<boolean> = () => isFlatJobPricingOn(),
): Promise<number> {
  if (!(await flatOn())) return def.reserve_credits;
  const executor = recipeExists(slug) ? loadChannelRecipe(slug).meta.executor : slug;
  const price = priceForJob({ agent_slug: executor, trigger: "channel_recipe", payload: { channel_slug: slug, top_action: { key } }, cron_dedupe_key: null });
  return price ? price.credits : def.reserve_credits;
}

export async function topActionContext(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = String(req.params.slug ?? "");
  const key = String(req.params.key ?? "");
  const formContext = topActionDef(slug, key) ? null : topActionFormContext(slug, key);
  if (formContext) {
    try {
      res.json(await formContext(auth.tenant_id));
    } catch (e) {
      console.warn(`[channels/top-actions] context ${slug}/${key}: ${(e as Error).message}`);
      res.json({});
    }
    return;
  }
  const found = defOf(req, res);
  if (!found) return;
  const credits = { credits: await topActionBilledCredits(found.slug, found.key, found.def) };
  if (!found.def.context) {
    res.json(credits);
    return;
  }
  try {
    res.json({ ...(await found.def.context(auth.tenant_id)), ...credits });
  } catch (e) {
    console.warn(`[channels/top-actions] context ${found.slug}/${found.key}: ${(e as Error).message}`);
    res.json(credits);
  }
}

export function runSummary(output_text: unknown, slug?: string): string | null {
  const plain = founderWords(output_text, slug);
  if (!plain) return null;
  if (plain.length <= 400) return plain;
  const tail = plain.slice(-399);
  if (!tail.includes("?")) return cutAtSentence(plain, 400, 200);
  const sentence = tail.search(/(?<=[.!?]\s)\S/);
  return `…${sentence > 0 && sentence < 200 ? tail.slice(sentence) : tail.trimStart()}`;
}

const NOTE_MAX = 4000;

export function runNote(output_text: unknown, slug?: string): string | null {
  const plain = founderWords(output_text, slug, true);
  if (!plain) return null;
  return plain.length <= NOTE_MAX ? plain : cutAtSentence(plain, NOTE_MAX, NOTE_MAX / 2);
}

const ACCOUNT_MODE_RE = /\bmode:\s*(?:linked|account[- ]blind)\b[.;:,]?\s*/gi;
const NAMED_ACCOUNT_RE = /\b(?:(?:ad\s+)?account)\s+(?:id\s+)?#?\d{5,}\s*[,:-]?\s*["\u201c]([^"\u201d\n]{1,120})["\u201d](?:\s*\([A-Z]{3}(?:\s*,\s*[A-Z_]+)?\))?/gi;
const QUOTED_ACCOUNT_STATUS_RE = /["\u201c]([^"\u201d\n]{1,120})["\u201d]\s*\([A-Z]{3}\s*,\s*[A-Z_]{4,}\)/g;
const ACCOUNT_NUMBER_PAREN_RE = /\s*\((?:ad\s+account|account|id)(?:\s+id)?\s*[#:]?\s*\d{5,}\)/gi;
const BARE_ACCOUNT_NUMBER_RE = /\b(?:(the|a|an|your|this|that)\s+)?(ad\s+account|account)\s+(?:id\s+)?#?\d{5,}\b/gi;
const ABBREVIATION_END_RE = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|est|Mr|Mrs|Ms|Dr|St|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Inc|Ltd|Co)|\b[A-Z](?:\.[A-Z])*)\.$/i;

function endsSentence(line: string): boolean {
  return /[.!?:;\u2026]["'\u201d\u2019)\]]*$/.test(line);
}

function linkedInAccountWords(text: string): string {
  const out = text
    .replace(ACCOUNT_MODE_RE, "")
    .replace(NAMED_ACCOUNT_RE, "$1")
    .replace(QUOTED_ACCOUNT_STATUS_RE, "$1")
    .replace(ACCOUNT_NUMBER_PAREN_RE, "")
    .replace(BARE_ACCOUNT_NUMBER_RE, (_m, det: string | undefined, noun: string) => `${det ?? "the"} ${noun.toLowerCase()}`)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|[^\w*])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
    .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
    .replace(/\*\*|`/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const TABLE_RULE_RE = /^\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?$/;
const LIST_ITEM_RE = /^([-*+]|\d{1,3}[.)])[ \t]+(.+)$/;

type FounderBlock = { list: false; text: string } | { list: true; items: Array<{ marker: string; text: string }> };

function tableItems(lines: string[]): Array<{ marker: string; text: string }> {
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(plainInline);
  const hasHeader = lines.length > 1 && TABLE_RULE_RE.test(lines[1].trim());
  const rows = lines.filter((l) => !TABLE_RULE_RE.test(l.trim())).map(cells);
  const head = hasHeader ? rows[0] : null;
  const body = hasHeader && rows.length > 1 ? rows.slice(1) : rows;
  return body
    .map((row) => row.map((c, i) => (c && head?.[i] && head !== row ? `${head[i]}: ${c}` : c)).filter(Boolean).join(", "))
    .filter(Boolean)
    .map((text) => ({ marker: "-", text }));
}

function founderBlocks(output_text: string): FounderBlock[] {
  const blocks: FounderBlock[] = [];
  let para: string[] = [];
  let items: Array<{ marker: string; text: string }> = [];
  let table: string[] = [];
  const flush = () => {
    const text = plainInline(para.join(" "));
    if (text) blocks.push({ list: false, text });
    para = [];
    const rows = [...items, ...tableItems(table)].filter((i) => i.text);
    if (rows.length) blocks.push({ list: true, items: rows });
    items = [];
    table = [];
  };
  for (const raw of output_text.replace(/<[^>]*>/g, " ").split(/\r?\n/)) {
    const indented = /^[ \t]{2,}\S/.test(raw);
    const line = raw.replace(/^[ \t]*(?:>[ \t]?)+/, "").trim();
    if (!line) { flush(); continue; }
    const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (heading) {
      flush();
      const text = plainInline(heading[1]);
      if (text) blocks.push({ list: false, text });
      continue;
    }
    if (line.startsWith("|")) {
      if (!table.length) flush();
      table.push(line);
      continue;
    }
    if (table.length) flush();
    const item = LIST_ITEM_RE.exec(line);
    if (item) {
      if (para.length) flush();
      items.push({ marker: /^\d/.test(item[1]) ? item[1].replace(")", ".") : "-", text: plainInline(item[2]) });
      continue;
    }
    if (items.length && indented) {
      const last = items[items.length - 1];
      last.text = `${last.text} ${plainInline(line)}`.trim();
      continue;
    }
    if (items.length) flush();
    para.push(line);
  }
  flush();
  return blocks;
}

const sentence = (text: string) => (endsSentence(text) ? text : `${text}.`);

function founderWords(output_text: unknown, slug?: string, keepBreaks = false): string | null {
  if (typeof output_text !== "string") return null;
  const blocks = founderBlocks(output_text);
  const plain = keepBreaks
    ? blocks.map((b) => (b.list ? b.items.map((i) => `${i.marker} ${i.text}`).join("\n") : sentence(b.text))).join("\n\n")
    : blocks.flatMap((b) => (b.list ? b.items.map((i) => sentence(i.text)) : [sentence(b.text)])).join(" ");
  if (!plain.trim()) return null;
  return slug === "linkedin_ads" ? linkedInAccountWords(plain) || null : plain;
}

function cutAtSentence(text: string, max: number, minEnd: number): string {
  const head = text.slice(0, max);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) {
    if (m.index! + 1 < minEnd) continue;
    if (m[0] === "." && ABBREVIATION_END_RE.test(head.slice(Math.max(0, m.index! - 12), m.index! + 1))) continue;
    end = m.index!;
  }
  if (end >= 0) return head.slice(0, end + 1);
  const space = text.slice(0, max - 1).lastIndexOf(" ");
  const cut = (space > 0 ? text.slice(0, space) : text.slice(0, max - 1)).replace(/[\s,;:\-\u2013\u2014]+$/, "");
  return `${cut}\u2026`;
}

const RunParams = z.object({ slug: z.string().min(1).max(64), run_id: z.string().uuid() });

export async function topActionRun(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const p = RunParams.safeParse(req.params);
  if (!p.success) {
    res.status(404).json({ error: { code: "not_found", message: "Run not found." } });
    return;
  }
  const { slug, run_id } = p.data;
  const notFound = () => res.status(404).json({ error: { code: "not_found", message: "Run not found." } });
  try {
    const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
      .from("agent_runs")
      .select("status, channel_slug, output_text")
      .eq("id", run_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const run = data as { status?: string; channel_slug?: string | null; output_text?: string | null } | null;
    if (!run || run.channel_slug !== slug) {
      notFound();
      return;
    }
    if (!(await canCurrentUserReadRun(auth.user_id, run_id))) {
      notFound();
      return;
    }
    const actions = await listActionViewsForRun(auth.tenant_id, run_id, slug);
    const status = run.status ?? "queued";
    const summary = status === "success" ? runSummary(run.output_text, slug) : null;
    const note = status === "success" ? runNote(run.output_text, slug) : null;
    res.json({ status, actions, summary, note });
  } catch (e) {
    console.warn(`[channels/top-actions] run ${run_id}: ${(e as Error).message}`);
    res.status(503).json({ error: { code: "run_unavailable", message: "Zavi couldn't read this run just now. Try again." } });
  }
}
