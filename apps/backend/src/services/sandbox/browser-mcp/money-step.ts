
import { navLooksSideEffecting } from "./browser-action-gate";

export type MoneyOpName = "click_ref" | "type_ref" | "select_option" | "set_checked" | "key" | "nav";

export type MoneyEvidence = {
  op: MoneyOpName;
  top_url: string | null;
  frame_url: string | null;
  role: string;
  name: string;
  hints: string;
  is_submit: boolean;
  form_has_card_field: boolean;
  budget_fields: { label: string; value: string }[];
  page_has_payment_frame: boolean;
  href?: string | null;
  amounts?: string[];
  budget_truncated?: boolean;
  scope_id?: number | null;
  typed_text?: string;
  nav_url?: string;
};

export type MoneyVerdict = {
  money: boolean;
  reason: string;
  host: string;
  label: string;
  value?: string;
  unsure?: boolean;
};

const MAX_LABEL = 80;
const MAX_VALUE = 120;

const STRONG_MONEY_LABELS = [
  "place order",
  "pay now",
  "pay",
  "purchase",
  "buy now",
  "buy",
  "confirm purchase",
  "complete purchase",
  "complete order",
  "add funds",
  "boost",
];
const CONTEXT_MONEY_LABELS = ["publish", "subscribe", "upgrade", "checkout", "check out", "launch campaign"];
const SAVE_LABELS = ["save", "submit", "update", "apply", "confirm", "done", "publish", "review and publish"];
const BARE_CONFIRM_LABELS = ["confirm", "continue", "submit"];

function wordRe(words: string[]): RegExp {
  const alts = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  return new RegExp(`\\b(?:${alts.join("|")})\\b`, "i");
}
const STRONG_RE = wordRe(STRONG_MONEY_LABELS);
const LINK_STRONG_RE = wordRe(["place order", "pay now", "pay", "confirm purchase", "complete purchase", "complete order", "add funds"]);
const MONEY_HOST_RE = /^(?:buy|pay|checkout|billing)\.|(?:^|\.)paypal\.com$|(?:^|\.)checkout\.stripe\.com$/i;
const CONTEXT_RE = wordRe(CONTEXT_MONEY_LABELS);
const SAVE_RE = wordRe(SAVE_LABELS);
const BUDGET_RE = /\b(?:budget|bid|bids|bidding|spend|spending\s+limit|cost\s+cap|bid\s+cap|daily\s+cap)\b/i;
export const BUDGET_WORDS_RE = BUDGET_RE;
const BILLING_URL_RE = /billing|payment|checkout/i;
const MONEY_NAV_SEGMENT_RE = /^(?:pay|checkout|purchase|subscribe)(?:[-_].*)?$/i;

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function parseUrl(u: string | null | undefined): URL | null {
  if (typeof u !== "string" || !u) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

export function hostOf(u: string | null | undefined): string {
  return parseUrl(u)?.hostname.toLowerCase() ?? "";
}

export function isAdHost(u: string | null | undefined): boolean {
  const url = parseUrl(u);
  if (!url) return false;
  const h = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase();
  if (h === "adsmanager.facebook.com" || h === "business.facebook.com") return true;
  if ((h === "www.facebook.com" || h === "facebook.com" || h === "m.facebook.com") && /^\/(adsmanager|ads)(\/|$)/.test(p)) {
    return true;
  }
  if (h === "ads.google.com") return true;
  if (h === "ads.tiktok.com") return true;
  if ((h === "www.linkedin.com" || h === "linkedin.com") && p.startsWith("/campaignmanager")) return true;
  return ["ads.x.com", "ads.twitter.com", "ads.reddit.com", "ads.snapchat.com", "ads.pinterest.com"].includes(h);
}

export function billingLooking(u: string | null | undefined): boolean {
  const url = parseUrl(u);
  return !!url && BILLING_URL_RE.test(`${url.hostname}${url.pathname}`);
}

export function navLooksLikeMoney(u: string): boolean {
  if (!navLooksSideEffecting(u)) return false;
  const url = parseUrl(u);
  if (!url) return false;
  return url.pathname
    .split("/")
    .filter(Boolean)
    .some((seg) => {
      try {
        return MONEY_NAV_SEGMENT_RE.test(decodeURIComponent(seg));
      } catch {
        return false;
      }
    });
}

function budgetValue(fields: MoneyEvidence["budget_fields"]): string {
  return fields
    .slice(0, 3)
    .map((f) => `${clean(f.label, 40) || "Budget"}: ${clean(f.value, 40)}`)
    .join("; ")
    .slice(0, MAX_VALUE);
}

function notMoney(host: string, label: string, unsure = false): MoneyVerdict {
  return { money: false, reason: unsure ? "unsure" : "none", host, label, ...(unsure ? { unsure } : {}) };
}

export function isMoneyStep(e: MoneyEvidence): MoneyVerdict {
  if (e.op === "nav") {
    const url = e.nav_url ?? "";
    const u = parseUrl(url);
    const host = u?.hostname.toLowerCase() ?? "";
    const label = u ? clean(`${u.hostname}${u.pathname}`, MAX_LABEL) : clean(url, MAX_LABEL);
    return navLooksLikeMoney(url)
      ? { money: true, reason: "nav_money_url", host, label }
      : notMoney(host, label);
  }

  const host = hostOf(e.top_url);
  const name = clean(e.name, MAX_LABEL);
  const label = name || clean(e.hints, MAX_LABEL);
  const ad = isAdHost(e.top_url) || isAdHost(e.frame_url);
  const billing = billingLooking(e.top_url) || billingLooking(e.frame_url);
  const cardContext = e.form_has_card_field || e.page_has_payment_frame || billing;

  if (e.op === "type_ref" || e.op === "select_option") {
    if (ad && BUDGET_RE.test(`${name} ${e.hints}`)) {
      return { money: true, reason: "ad_budget_field", host, label, value: clean(e.typed_text, MAX_VALUE) };
    }
    return notMoney(host, label);
  }

  const isLink = e.role.toLowerCase() === "link";
  if (isLink) {
    const dest = e.href ? parseUrl(e.href) : null;
    if (
      (e.href && navLooksLikeMoney(e.href)) ||
      (dest && MONEY_HOST_RE.test(dest.hostname)) ||
      LINK_STRONG_RE.test(name)
    ) {
      return { money: true, reason: "link_money_url", host, label };
    }
  }
  if (!isLink && STRONG_RE.test(name)) {
    return { money: true, reason: "money_label", host, label };
  }
  if (!isLink && CONTEXT_RE.test(name) && (ad || cardContext)) {
    return { money: true, reason: "money_label_in_context", host, label };
  }
  if (e.is_submit && e.form_has_card_field) {
    return { money: true, reason: "card_form_submit", host, label };
  }
  if (ad && e.budget_fields.length > 0 && (e.is_submit || (!isLink && SAVE_RE.test(name)))) {
    return { money: true, reason: "ad_budget_save", host, label, value: budgetValue(e.budget_fields) };
  }
  const bare = BARE_CONFIRM_LABELS.includes(name.toLowerCase().replace(/[.!…→>\s]+$/u, ""));
  return notMoney(host, label, bare && billing);
}

function bool(v: unknown): boolean {
  return v === true;
}

export function evidenceFromResolve(
  op: { op: MoneyOpName; text?: string },
  result: unknown,
): MoneyEvidence {
  const r = (result ?? {}) as Record<string, unknown>;
  const form = (r.form ?? {}) as Record<string, unknown>;
  const budgets = Array.isArray(form.budget_fields) ? form.budget_fields : [];
  return {
    op: op.op,
    top_url: typeof r.top_url === "string" ? r.top_url : null,
    frame_url: typeof r.frame_url === "string" ? r.frame_url : null,
    role: clean(r.role, 40),
    name: clean(r.name, 200),
    hints: clean(r.hints, 200),
    is_submit: bool(r.is_submit),
    form_has_card_field: bool(form.has_card_field),
    budget_fields: budgets.slice(0, 5).map((b) => {
      const f = (b ?? {}) as Record<string, unknown>;
      return { label: clean(f.label, 80), value: clean(f.value, 80) };
    }),
    page_has_payment_frame: bool(r.page_has_payment_frame),
    href: absoluteHref(r.href, r.frame_url, r.top_url),
    amounts: Array.isArray(r.amounts) ? r.amounts.slice(0, 30).map((a) => clean(a, 40)) : [],
    budget_truncated: bool(form.budget_truncated),
    scope_id: Number.isInteger(form.scope_node_id) ? (form.scope_node_id as number) : null,
    ...(op.op === "type_ref" || op.op === "select_option" ? { typed_text: typeof op.text === "string" ? op.text : "" } : {}),
  };
}

function absoluteHref(href: unknown, frameUrl: unknown, topUrl: unknown): string | null {
  if (typeof href !== "string" || !href) return null;
  const base = typeof frameUrl === "string" ? frameUrl : typeof topUrl === "string" ? topUrl : undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export type ResolvedTarget = {
  frame_session: string | null;
  backend_node_id: number | null;
};

export function targetFromResolve(result: unknown): ResolvedTarget {
  const ref = ((result ?? {}) as { ref?: unknown }).ref as
    | { frame_session?: unknown; backend_node_id?: unknown }
    | null
    | undefined;
  return {
    frame_session: typeof ref?.frame_session === "string" ? ref.frame_session : null,
    backend_node_id: Number.isInteger(ref?.backend_node_id) ? (ref!.backend_node_id as number) : null,
  };
}

export function moneyStepIdentity(
  op: Record<string, unknown>,
  e: MoneyEvidence,
  v: MoneyVerdict,
  target: ResolvedTarget,
): Record<string, string | number | boolean | null> {
  return {
    op: e.op,
    op_args: canonicalOpArgs(op),
    reason: v.reason,
    host: v.host,
    label: v.label,
    value: v.value ?? null,
    role: e.role,
    frame_url: e.frame_url,
    frame_session: target.frame_session,
    backend_node_id: target.backend_node_id,
    is_submit: e.is_submit,
    form_has_card_field: e.form_has_card_field,
    page_has_payment_frame: e.page_has_payment_frame,
    scope_id: e.scope_id ?? null,
    budget_fields: JSON.stringify(e.budget_fields.map((b) => [b.label, b.value])),
    href: e.href ?? null,
    amounts: JSON.stringify(e.amounts ?? []),
    top_host: hostOf(e.top_url),
  };
}

export function canonicalOpArgs(op: Record<string, unknown>): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(op));
}

export function identityDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

export function sameMoneyValue(a: string, b: string): boolean {
  const num = (v: string): number | null => {
    const digits = v.replace(/[^0-9.]/g, "");
    if (!/\d/.test(digits) || (digits.match(/\./g) ?? []).length > 1) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  };
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null) return x === y;
  return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== "";
}
