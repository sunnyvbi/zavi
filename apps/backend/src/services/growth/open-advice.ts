
import { randomUUID } from "node:crypto";
import { CHANNELS } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { failedDefinitely } from "@/services/channels/exec-failure";
import { adDirection } from "./unattended-policy";

export type SubjectRefs = { ids: string[]; names: string[] };

export const SUBJECT_REFS_KEY = "subject_refs";

const OBJECT_ID_KEYS = ["object_id", "ad_set_id", "ad_group_id", "ad_id", "campaign_id", "source_ad_set_id", "source_campaign_id"] as const;
const MAX_REFS = 10;
export const MIN_NAME_CHARS = 4;
const ID_RE = /\b(?:\d{9,20}|cmpn_[A-Za-z0-9]+)\b/g;
const QUOTED_RE = /[“"«]([^“”"«»\n]{2,120})[”"»]/g;

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x.length > 0))].slice(0, MAX_REFS);
}

export function refsFromPayload(payload: unknown): SubjectRefs {
  const p = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  const ids: string[] = [];
  for (const k of OBJECT_ID_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) ids.push(v.trim());
    else if (typeof v === "number" && Number.isFinite(v)) ids.push(String(v));
  }
  const nested = p.campaign && typeof p.campaign === "object" ? (p.campaign as Record<string, unknown>).name : undefined;
  const raw = typeof p.name === "string" ? p.name : typeof nested === "string" ? nested : "";
  const name = raw.trim();
  return { ids: uniq(ids), names: name.length >= MIN_NAME_CHARS ? [name.slice(0, 200)] : [] };
}

export function refsFromText(...texts: Array<string | null | undefined>): SubjectRefs {
  const t = texts.filter((x): x is string => typeof x === "string").join("\n");
  const ids = [...t.matchAll(ID_RE)].map((m) => m[0]);
  const names = [...t.matchAll(QUOTED_RE)].map((m) => m[1].trim()).filter((n) => n.length >= MIN_NAME_CHARS);
  return { ids: uniq(ids), names: uniq(names) };
}

export function mergeRefs(...rs: Array<SubjectRefs | null | undefined>): SubjectRefs {
  return {
    ids: uniq(rs.flatMap((r) => r?.ids ?? [])),
    names: uniq(rs.flatMap((r) => r?.names ?? [])),
  };
}

export function storedRefs(v: unknown): SubjectRefs | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as { ids?: unknown; names?: unknown };
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return { ids: uniq(strs(r.ids)), names: uniq(strs(r.names)) };
}

export function cardSubjectRefs(input: { title?: string | null; stepBody?: string | null; evidence?: unknown; execPayload?: unknown }): SubjectRefs {
  const ev = Array.isArray(input.evidence) ? input.evidence.filter((e): e is string => typeof e === "string") : [];
  return mergeRefs(refsFromPayload(input.execPayload), refsFromText(input.title, input.stepBody, ...ev));
}

export type OpenCardRow = {
  id: string;
  run_id: string | null;
  channel_slug: string;
  title: string;
  exec_class: string | null;
  exec_payload: unknown;
  exec_status?: string | null;
  exec_result?: unknown;
  body: unknown;
};

export function refsOfRow(r: Pick<OpenCardRow, "title" | "exec_payload" | "body">): { refs: SubjectRefs; text: string } {
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as { step?: { body?: unknown; evidence?: unknown }; [k: string]: unknown };
  const stepBody = typeof b.step?.body === "string" ? b.step.body : "";
  return {
    refs: mergeRefs(storedRefs(b[SUBJECT_REFS_KEY]), cardSubjectRefs({ title: r.title, stepBody, evidence: b.step?.evidence, execPayload: r.exec_payload })),
    text: normName(`${r.title ?? ""}\n${stepBody}`),
  };
}

export type AdObject = { ids: string[]; name: string | null; names?: string[]; nameUnknown?: boolean };

export type AdNameReader = (exec_class: string, payload: Record<string, unknown>, ids: string[]) => Promise<string[]>;

const NUMERIC_ID = /^\d{1,20}$/;

export function liveAdNameReader(tenant_id: string): AdNameReader {
  return async (exec_class, payload, ids) => {
    const id = ids[0];
    if (id && exec_class.startsWith("chatgpt_ads.")) {
      const { ownedCampaign } = await import("@/services/connectors/chatgpt-ads/workspace");
      return [String((await ownedCampaign(tenant_id, id)).campaign.name)];
    }
    if (!id || !NUMERIC_ID.test(id)) return [];
    const out: string[] = [];
    if (exec_class.startsWith("meta_ads.")) {
      const { fbGet } = await import("@/services/tools/meta-ads/_client");
      const campaignLevel = payload.level === "campaign" || (!payload.object_id && !payload.ad_set_id && !payload.ad_id && typeof payload.campaign_id === "string");
      const r = (await fbGet(tenant_id, id, { fields: campaignLevel ? "name" : "name,campaign{name}" })) as { name?: unknown; campaign?: { name?: unknown } };
      for (const n of [r?.name, r?.campaign?.name]) if (typeof n === "string") out.push(n);
      return out;
    }
    if (exec_class.startsWith("google_ads.")) {
      const { gadsSearch } = await import("@/services/tools/google-ads/_client");
      const ag = typeof payload.ad_group_id === "string" || typeof payload.ad_group_id === "number" ? String(payload.ad_group_id) : null;
      if (ag && NUMERIC_ID.test(ag)) {
        const rows = (await gadsSearch(tenant_id, `SELECT ad_group.name, campaign.name FROM ad_group WHERE ad_group.id = ${ag} LIMIT 1`)) as Array<{ adGroup?: { name?: string }; campaign?: { name?: string } }>;
        for (const n of [rows[0]?.adGroup?.name, rows[0]?.campaign?.name]) if (typeof n === "string") out.push(n);
        return out;
      }
      const c = payload.campaign_id != null ? String(payload.campaign_id) : null;
      if (c && NUMERIC_ID.test(c)) {
        const rows = (await gadsSearch(tenant_id, `SELECT campaign.name FROM campaign WHERE campaign.id = ${c} LIMIT 1`)) as Array<{ campaign?: { name?: string } }>;
        if (typeof rows[0]?.campaign?.name === "string") out.push(rows[0].campaign.name);
      }
      return out;
    }
    return out;
  };
}

export function objectFromNames(refs: SubjectRefs, read: string[] | null): AdObject {
  const name = refs.names[0] ?? null;
  if (name || refs.ids.length === 0) return { ids: refs.ids, name };
  const names = uniq((read ?? []).map((n) => n.trim()).filter((n) => normName(n).length >= MIN_NAME_CHARS));
  return names.length ? { ids: refs.ids, name: names[0], names } : { ids: refs.ids, name: null, nameUnknown: true };
}

export async function adObjectFor(tenant_id: string, exec_class: string, payload: unknown, read?: AdNameReader): Promise<AdObject> {
  const refs = refsFromPayload(payload);
  if (refs.names.length > 0 || refs.ids.length === 0) return objectFromNames(refs, null);
  try {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    return objectFromNames(refs, await (read ?? liveAdNameReader(tenant_id))(exec_class, p, refs.ids));
  } catch (e) {
    console.warn(`[open-advice] name of ${refs.ids[0]} unreadable for ${tenant_id}; any prose card may be about it: ${(e as Error).message}`);
    return objectFromNames(refs, null);
  }
}

export function cardNamesObject(card: { refs: SubjectRefs; text: string }, obj: AdObject): boolean {
  if (obj.ids.some((id) => card.refs.ids.includes(id))) return true;
  return [obj.name, ...(obj.names ?? [])].some((raw) => {
    const n = raw ? normName(raw) : "";
    if (n.length < MIN_NAME_CHARS) return false;
    return card.refs.names.some((x) => normName(x) === n) || card.text.includes(n);
  });
}

export function textNamesCard(text: string, card: { refs: SubjectRefs }): boolean {
  const t = normName(text);
  if (card.refs.ids.some((id) => t.includes(id.toLowerCase()))) return true;
  return card.refs.names.some((n) => {
    const x = normName(n);
    return x.length >= MIN_NAME_CHARS && t.includes(x);
  });
}

export function channelsForAdClass(decision_class: string): string[] {
  if (decision_class.startsWith("chatgpt_ads.")) return ["chatgpt_ads"];
  if (decision_class.startsWith("x_ads.")) return ["x_ads"];
  if (decision_class.startsWith("reddit_ads.")) return ["reddit_ads"];
  if (decision_class.startsWith("tiktok_ads.")) return ["tiktok_ads"];
  if (decision_class.startsWith("linkedin_ads.")) return ["linkedin_ads"];
  if (decision_class.startsWith("meta_ads.")) return ["meta_ads"];
  if (decision_class.startsWith("google_ads.")) return ["google_ads", "youtube_ads"];
  return [];
}

export function textDirection(text: string): "up" | "down" | "create" | "other" | "mixed" {
  const t = text.toLowerCase();
  const hits = new Set<string>();
  if (/\b(pause|pausing|stop|turn(ing)? off|switch off|disable|lower|cut|reduce|decrease|shut)\b/.test(t)) hits.add("down");
  if (/\b(resume|restart|turn(ing)? on|switch on|unpause|re-?enable|enable|raise|increase|scale|boost|reactivate)\b/.test(t)) hits.add("up");
  if (/\b(create|launch|new ad|new campaign|add)\b/.test(t)) hits.add("create");
  if (/\b(rebuild|rework|restructure|replace|switch to|convert)\b/.test(t)) hits.add("other");
  if (hits.size === 0) return "other";
  return hits.size === 1 ? ([...hits][0] as "up" | "down" | "create" | "other") : "mixed";
}

export function envelopeOfExec(
  card: { title: string; stepBody?: string | null; evidence?: unknown },
  exec: { exec_class: string; exec_payload: unknown },
): boolean {
  const dir = adDirection(exec.exec_class, exec.exec_payload);
  if (dir !== "up" && dir !== "down") return false;
  const text = normName(`${card.title ?? ""}\n${card.stepBody ?? ""}`);
  if (textDirection(text) !== dir) return false;
  const refs = cardSubjectRefs({ title: card.title, stepBody: card.stepBody, evidence: card.evidence });
  return cardNamesObject({ refs, text }, objectFromNames(refsFromPayload(exec.exec_payload), null));
}

const POINTER_WORDS = /\b(approve|approval|reject|sign off|go ahead|confirm)\b/i;
function titleAmountsMatch(title: string, payload: unknown): boolean {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const own = new Set(
    Object.entries(p)
      .filter(([k, v]) => /budget/i.test(k) && typeof v === "number" && Number.isFinite(v))
      .map(([, v]) => Math.round((v as number) * 100)),
  );
  let bare = title.replace(/["“”'‘’][^"“”'‘’]{1,200}["“”'‘’]/g, " ");
  if (typeof p.name === "string" && p.name.trim()) bare = bare.split(p.name.trim()).join(" ");
  const named = [...bare.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, "")) * 100));
  return named.every((c) => own.has(c));
}

const OTHER_LEVER = /\b(bids?|bidding|creatives?|audiences?|targeting|copy|headlines?|images?|videos?|placements?|keywords?|landing page)\b/i;
const CHANGE_NOUN = /\b(raise|cut|budget|spend)\b/i;

export function pointerOfExec(
  card: { title: string; stepBody?: string | null; evidence?: unknown; targetRef?: string | null },
  exec: { exec_class: string; exec_payload: unknown },
): boolean {
  const execRefs = refsFromPayload(exec.exec_payload);
  if (execRefs.ids.length === 0 && execRefs.names.length === 0) return false;
  const words = `${card.title ?? ""}\n${card.stepBody ?? ""}`;
  const dir = twinDirection(exec);
  const said = textDirection(words);
  const aboutTheChange =
    said === "up" || said === "down"
      ? said === dir
      : said === "other" && POINTER_WORDS.test(words) && CHANGE_NOUN.test(words);
  if (!aboutTheChange) return false;
  if (OTHER_LEVER.test(words)) return false;
  const ctl = textControl(words);
  if (ctl === "mixed" || ctl === "create") return false;
  if ((ctl === "budget" || ctl === "status") && ctl !== controlOfExecClass(exec.exec_class)) return false;
  if (!titleAmountsMatch(card.title ?? "", exec.exec_payload)) return false;
  const ref = (card.targetRef ?? "").trim();
  const own = cardSubjectRefs({ title: card.title, stepBody: card.stepBody, evidence: card.evidence });
  const refs = ref ? mergeRefs(own, { ids: [ref], names: !NUMERIC_ID.test(ref) && ref.length >= MIN_NAME_CHARS ? [ref] : [] }) : own;
  const text = normName(`${card.title ?? ""}\n${card.stepBody ?? ""}`);
  return cardNamesObject({ refs, text }, objectFromNames(execRefs, null));
}

const DOWN_STATUS = /^(paused?|disabled?|archived?|stop(ped)?|inactive|off)$/i;
const UP_STATUS = /^(active|enabled?|resumed?|running|on|unpaused?)$/i;
const OLD_BUDGET_KEY = /(current|old|previous|expected|from)/i;

export function twinDirection(exec: { exec_class: string; exec_payload: unknown }): "up" | "down" | "create" | "other" {
  const suffix = exec.exec_class.split(".")[1] ?? exec.exec_class;
  if (/(create|launch|new_|duplicate)/i.test(suffix)) return "create";
  const known = adDirection(exec.exec_class, exec.exec_payload);
  if (known === "up" || known === "down" || known === "create") return known;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const p = obj(exec.exec_payload);
  const changes = { ...obj(obj(p.request).changes), ...obj(p.changes) };
  const before = obj(p.before);
  for (const src of [p, changes]) {
    for (const k of ["status", "entity_status", "new_status", "target_status", "operational_status"]) {
      const v = src[k];
      if (typeof v === "string") {
        if (DOWN_STATUS.test(v.trim())) return "down";
        if (UP_STATUS.test(v.trim())) return "up";
      }
    }
  }
  if (/pause/i.test(suffix)) return "down";
  if (/(resume|enable)/i.test(suffix)) return "up";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const [k, v] of Object.entries(changes)) {
    const was = num(before[k]);
    const now = num(v);
    if (/budget/i.test(k) && was !== null && now !== null && now !== was) return now > was ? "up" : "down";
  }
  const budgets = Object.entries(p).filter(([k, v]) => /budget/i.test(k) && num(v) !== null);
  const old = budgets.find(([k]) => OLD_BUDGET_KEY.test(k));
  const next = budgets.find(([k]) => !OLD_BUDGET_KEY.test(k));
  if (old && next && next[1] !== old[1]) return (next[1] as number) > (old[1] as number) ? "up" : "down";
  return "other";
}

function textControl(text: string): "budget" | "status" | "create" | "mixed" | "other" {
  const t = text.toLowerCase();
  const hits = new Set<string>();
  if (/\b(budget|bid|daily cap)\b/.test(t) || /\b(?:raise|increase|reduce|lower|cut)\b[^.!?\n]{0,40}\bspend\b/.test(t)) hits.add("budget");
  if (/\b(pause|pausing|resume|unpause|stop|turn(ing)? (on|off)|switch (on|off)|enable|disable|reactivate|shut)\b/.test(t)) hits.add("status");
  if (/\b(create|launch|new ad|new campaign)\b/.test(t)) hits.add("create");
  if (hits.size === 0) return "other";
  return hits.size === 1 ? ([...hits][0] as "budget" | "status" | "create") : "mixed";
}

export function chatTwinOfExec(
  card: { title: string; stepBody?: string | null; evidence?: unknown },
  exec: { exec_class: string; exec_payload: unknown },
): boolean {
  const dir = twinDirection(exec);
  if (dir === "other") return false;
  const raw = `${card.title ?? ""}\n${card.stepBody ?? ""}`;
  const text = normName(raw);
  let verbs = raw.replace(new RegExp(QUOTED_RE.source, "g"), " ");
  for (const n of refsFromPayload(exec.exec_payload).names) verbs = verbs.split(n).join(" ");
  const control = textControl(verbs);
  const verbDir = textDirection(verbs);
  if (dir === "create") {
    return false;
  } else {
    if (verbDir !== dir) return false;
    const execControl = controlOfExecClass(exec.exec_class);
    const wanted = execControl === "budget" || execControl === "status" ? execControl : /budget/i.test(JSON.stringify(exec.exec_payload ?? "")) ? "budget" : "status";
    if (control !== wanted) return false;
    if (wanted === "budget" && !sameChatBudgetValue(verbs, exec.exec_payload, exec.exec_class)) return false;
  }
  const refs = cardSubjectRefs({ title: card.title, stepBody: card.stepBody, evidence: card.evidence });
  const execRefs = refsFromPayload(exec.exec_payload);
  if (refs.ids.length && execRefs.ids.length && !refs.ids.every((id) => execRefs.ids.includes(id))) return false;
  if (refs.names.some((name) => !execRefs.names.some((execName) => normName(execName) === normName(name)))) return false;
  const titleRest = execRefs.names.reduce((t, n) => t.split(normName(n)).join(" "), normName(card.title ?? ""));
  if (/\band\b|&|,|\bplus\b/.test(titleRest)) return false;
  return cardNamesObject({ refs, text }, objectFromNames(execRefs, null));
}

function sameChatBudgetValue(text: string, payload: unknown, execClass: string): boolean {
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const p = obj(payload);
  const changes = { ...obj(obj(p.request).changes), ...obj(p.changes) };
  const before = obj(p.before);
  const source = Object.keys(changes).length ? changes : p;
  const keys = ["new_daily_budget", "daily_budget_usd", "new_daily_budget_usd", ...(execClass.startsWith("x_ads.") ? ["daily_budget"] : [])];
  const targets = keys.flatMap((k) => typeof source[k] === "number" && Number.isFinite(source[k]) ? [source[k] as number] : []);
  if (targets.length !== 1 || /\b(?:lifetime|total|week|weekly|month|monthly|year|hour|bid|eur|gbp)\b|[€£]/i.test(text)) return false;
  const currencies = [p.currency, p.account_currency, changes.currency, before.currency, before.account_currency]
    .filter((v): v is string => typeof v === "string").map(v => v.trim().toUpperCase());
  if (currencies.some(c => c !== "USD") && /\$|\bUSD\b/i.test(text)) return false;
  if (/\b(?:CAD|AUD|NZD|SGD|HKD|TWD|MXN|ARS|CLP|COP|INR|JPY|CNY|RMB|CHF|AED|SAR|ZAR|BRL)\b|[₹¥₩₽]/i.test(text)) return false;
  const amounts = [...text.matchAll(/\bto\s*(?:USD\s*|\$)?(\d+(?:,\d{3})*(?:\.\d+)?)\b/gi)];
  if (amounts.length === 1 && !/%|\bby\s*\d/i.test(text)) {
    return Number(amounts[0][1].replace(/,/g, "")) === targets[0];
  }
  const percent = text.match(/\bby\s+(\d+(?:\.\d+)?)\s*%/i);
  const old = p.current_daily_budget ?? before.daily_budget ?? before.daily_budget_usd;
  if (percent && amounts.length === 0 && typeof old === "number") {
    const sign = textDirection(text) === "down" ? -1 : 1;
    return Math.abs(old * (1 + sign * Number(percent[1]) / 100) - targets[0]) < 0.000001;
  }
  return false;
}

function isOwnEnvelope(card: OpenCardRow, run_id: string | null | undefined, exec?: { exec_class: string; exec_payload: unknown }): boolean {
  if (!run_id || card.run_id !== run_id || card.exec_class || !exec) return false;
  const mine = adDirection(exec.exec_class, exec.exec_payload);
  return mine !== "other" && textDirection(refsOfRow(card).text) === mine;
}

function sameChange(card: OpenCardRow, exec?: { exec_class: string; exec_payload: unknown }): boolean {
  if (!exec || !card.exec_class) return false;
  if (sameBudgetMove(card.exec_class, card.exec_payload, exec.exec_class, exec.exec_payload)) return true;
  if (card.exec_class !== exec.exec_class) return false;
  return JSON.stringify(card.exec_payload ?? null) === JSON.stringify(exec.exec_payload ?? null);
}

const BUDGET_UPDATE = /^([a-z_]+)\.(update_campaign_budget|update_ad_set_budget)(?:_review)?$/;

export function sameBudgetMove(aClass: string, aPayload: unknown, bClass: string, bPayload: unknown): boolean {
  const a = BUDGET_UPDATE.exec(aClass);
  const b = BUDGET_UPDATE.exec(bClass);
  if (!a || !b || a[1] !== b[1] || a[2] !== b[2]) return false;
  const pa = (aPayload && typeof aPayload === "object" ? aPayload : {}) as Record<string, unknown>;
  const pb = (bPayload && typeof bPayload === "object" ? bPayload : {}) as Record<string, unknown>;
  const idKey = a[2] === "update_campaign_budget" ? "campaign_id" : "ad_set_id";
  const id = (p: Record<string, unknown>) => (typeof p[idKey] === "string" || typeof p[idKey] === "number" ? String(p[idKey]).trim() : "");
  if (!id(pa) || id(pa) !== id(pb)) return false;
  const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null);
  const near = (key: string) => {
    const x = cents(pa[key]);
    const y = cents(pb[key]);
    return x !== null && y !== null && Math.abs(x - y) <= 1;
  };
  return near("daily_budget_usd") && near("expected_current_daily_budget_usd");
}

export function controlOfExecClass(exec_class: string): string {
  const suffix = exec_class.split(".")[1] ?? exec_class;
  if (suffix.includes("budget")) return "budget";
  if (suffix.includes("status") || suffix.includes("pause") || suffix.includes("resume")) return "status";
  if (suffix.includes("geo")) return "targeting";
  return suffix;
}

function cardStillBlocks(card: OpenCardRow, exec?: { exec_class: string; exec_payload: unknown }): boolean {
  if (card.exec_status !== "failed") return true;
  if (!exec || !card.exec_class) return true;
  if (!failedDefinitely(card)) return true;
  return controlOfExecClass(card.exec_class) === controlOfExecClass(exec.exec_class);
}

function excusedAsSameChange(card: OpenCardRow, exec?: { exec_class: string; exec_payload: unknown }): boolean {
  if (!sameChange(card, exec)) return false;
  return card.exec_status !== "failed" || failedDefinitely(card);
}

function proseOfExcusedExec(card: OpenCardRow, excused: readonly OpenCardRow[]): boolean {
  if (card.exec_class || !card.run_id) return false;
  const b = (card.body && typeof card.body === "object" ? card.body : {}) as { step?: { body?: unknown; evidence?: unknown; target?: { ref?: unknown } | null } };
  const stepBody = typeof b.step?.body === "string" ? b.step.body : null;
  const targetRef = typeof b.step?.target?.ref === "string" ? b.step.target.ref : null;
  const dir = textDirection(refsOfRow(card).text);
  if (dir !== "up" && dir !== "down") return false;
  return excused.some(
    (e) =>
      !!e.exec_class &&
      e.run_id === card.run_id &&
      twinDirection({ exec_class: e.exec_class, exec_payload: e.exec_payload }) === dir &&
      pointerOfExec({ title: card.title, stepBody, evidence: b.step?.evidence, targetRef }, { exec_class: e.exec_class, exec_payload: e.exec_payload }),
  );
}

export type OpenAdviceCheck =
  | { status: "clear" }
  | { status: "conflict"; cards: Array<{ id: string; channel_slug: string; title: string }> }
  | { status: "error"; message: string };

export async function readOpenCards(tenant_id: string, channels: readonly string[]): Promise<OpenCardRow[]> {
  if (channels.length === 0) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id, run_id, channel_slug, title, exec_class, exec_payload, exec_status, exec_result, body")
    .eq("tenant_id", tenant_id)
    .in("channel_slug", [...channels])
    .eq("status", "pending")
    .order("proposed_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<OpenCardRow & { exec_status?: string | null }>).filter(
    (r) => r.exec_status == null || r.exec_status === "failed",
  );
}

export async function findContradictingOpenAdvice(args: {
  tenant_id: string;
  channels: readonly string[];
  object: AdObject;
  exclude: { action_id?: string | null; run_id?: string | null };
  exec?: { exec_class: string; exec_payload: unknown };
}): Promise<OpenAdviceCheck> {
  if (args.object.ids.length === 0 && !(args.object.name && normName(args.object.name).length >= MIN_NAME_CHARS)) {
    return { status: "clear" };
  }
  let rows: OpenCardRow[];
  try {
    rows = await readOpenCards(args.tenant_id, args.channels);
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
  const cards = contradictingCards(rows, args);
  return cards.length > 0 ? { status: "conflict", cards } : { status: "clear" };
}

export function contradictingCards(
  rows: readonly OpenCardRow[],
  args: { object: AdObject; exclude: { action_id?: string | null; run_id?: string | null }; exec?: { exec_class: string; exec_payload: unknown } },
): Array<{ id: string; channel_slug: string; title: string }> {
  const excusedExecs = rows.filter((r) => r.id !== args.exclude.action_id && excusedAsSameChange(r, args.exec));
  return rows
    .filter((r) => r.id !== args.exclude.action_id)
    .filter((r) => !isOwnEnvelope(r, args.exclude.run_id, args.exec))
    .filter((r) => !excusedAsSameChange(r, args.exec))
    .filter((r) => !proseOfExcusedExec(r, excusedExecs))
    .filter((r) => cardStillBlocks(r, args.exec))
    .filter((r) => cardNamesObject(refsOfRow(r), args.object) || (args.object.nameUnknown === true && !r.exec_class))
    .map((r) => ({ id: r.id, channel_slug: r.channel_slug, title: r.title }));
}

export function channelName(slug: string): string {
  return CHANNELS.find((c) => c.slug === slug)?.name ?? slug;
}

export function heldChangeKey(v: unknown): string | null {
  const o = (v && typeof v === "object" ? v : {}) as { kind?: unknown; exec_class?: unknown; object_id?: unknown; from_usd?: unknown; to_usd?: unknown };
  if (o.kind !== "held_ad_order") return null;
  const cents = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null);
  const from = cents(o.from_usd);
  const to = cents(o.to_usd);
  const way = from === null || to === null ? null : to > from ? "up" : to < from ? "down" : "same";
  return JSON.stringify([o.exec_class, o.object_id, from, way]);
}

export async function askFounderOutsideReview(args: {
  tenant_id: string;
  topic: string;
  ask: string;
  now?: Date;
  on_yes?: import("./cgo-questions").OnYes | null;
}): Promise<boolean> {
  try {
    const now = args.now ?? new Date();
    const { readQuestions, normalizeTopic, insertQuestions, REASK_AFTER_DAYS } = await import("./cgo-questions");
    const topic = normalizeTopic(args.topic);
    let existing = await readQuestions(args.tenant_id, now);
    const since = now.getTime() - REASK_AFTER_DAYS * 86_400_000;
    if (args.on_yes?.kind === "held_ad_order") {
      const open = existing.filter((q) => q.topic_key === topic && (q.status === "open" || q.status === "queued"));
      if (open.length > 0) {
        const db = tenantClient(asTenantId(args.tenant_id));
        const { data: rows, error } = await db.from("cgo_questions").select("id, on_yes").eq("tenant_id", args.tenant_id).in("id", open.map((q) => q.id));
        if (error) return false;
        const want = heldChangeKey(args.on_yes);
        const stale = ((rows ?? []) as Array<{ id: string; on_yes: unknown }>).filter((r) => heldChangeKey(r.on_yes) !== want).map((r) => r.id);
        if (stale.length < open.length) return false;
        const { error: wErr } = await db.from("cgo_questions").update({ status: "withdrawn" }).eq("tenant_id", args.tenant_id).in("id", stale).in("status", ["open", "queued"]);
        if (wErr) return false;
        existing = existing.filter((q) => !stale.includes(q.id));
      }
    }
    const asked = existing.some(
      (q) =>
        q.topic_key === topic &&
        (q.status === "open" || q.status === "queued" || (q.status === "answered" && Date.parse(q.answered_at ?? q.asked_at) >= since)),
    );
    if (asked) return false;
    const { normalizeAsk } = await import("./question-text");
    const n = normalizeAsk(args.ask, null, { required: true });
    if (!n) return false;
    const ask = n.ask;
    const stored = await insertQuestions(args.tenant_id, null, [
      { topic_key: topic, ask, default_action: null, expires_at: null, ...(args.on_yes ? { on_yes: args.on_yes } : {}) },
    ]);
    if (stored.length === 0) return false;
    const db = tenantClient(asTenantId(args.tenant_id));
    const { data: last } = await db
      .from("cgo_notes")
      .select("next_review_at")
      .eq("tenant_id", args.tenant_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ next_review_at: string }>();
    const { data: note, error } = await db
      .from("cgo_notes")
      .insert({
        tenant_id: args.tenant_id,
        run_id: null,
        kind: "alarm",
        need: [ask],
        questions: [ask],
        queued_at: now.toISOString(),
        notified: false,
        notification_key: `note:${randomUUID()}`,
        next_review_at: last?.next_review_at ?? new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      })
      .select("id")
      .maybeSingle<{ id: string }>();
    if (error || !note) {
      console.warn(`[open-advice] note write failed for ${args.tenant_id}: ${error?.message ?? "no row"}`);
      return true;
    }
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: `cgo-note-email:note:${note.id}`, name: "cgo/note.email", data: { note_id: note.id, tenant_id: args.tenant_id } });
    return true;
  } catch (e) {
    console.warn(`[open-advice] asking the founder failed for ${args.tenant_id}: ${(e as Error).message}`);
    return false;
  }
}

export async function assertNoContradictingOpenAdvice(args: {
  tenant_id: string;
  channels: readonly string[];
  object: AdObject;
  exclude: { action_id?: string | null; run_id?: string | null };
  exec?: { exec_class: string; exec_payload: unknown };
}): Promise<boolean> {
  const check = await findContradictingOpenAdvice(args);
  if (check.status === "clear") return true;
  if (check.status === "error") {
    console.warn(`[open-advice] open cards unreadable for ${args.tenant_id}; left for the founder: ${check.message}`);
    return false;
  }
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: "info",
      source: "open-advice",
      code: "cgo.open_advice_conflict",
      message: "autopilot approval refused: a channel card names the same object",
      tenant_id: args.tenant_id,
      meta: { hold_reasons: "open_advice_conflict" },
    });
  } catch {
  }
  return false;
}
