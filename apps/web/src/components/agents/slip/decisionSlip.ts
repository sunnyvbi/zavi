
import { adChangeMoney, adMoney, type AdChangeMoney } from "@zavi/shared";
import { parseProposalView, type ProposalChip, type ProposalField } from "../proposalView";
import type { ComposioCardPhase } from "@/app/approvals/composioChatCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

export type SlipStage = "waiting" | "queued" | "sending" | "unknown" | "done" | "failed" | "rejected" | "closed" | "held" | "partial";

export function slipStage(phase: ComposioCardPhase, status: string): SlipStage {
  switch (phase) {
    case "pending":
      return "waiting";
    case "running":
      return status === "approved" ? "queued" : "sending";
    case "outcome_unknown":
      return "unknown";
    default:
      return phase;
  }
}

export type SlipTone = "up" | "down" | "flat";

export type SlipHero = {
  eyebrow: string;
  amount: string;
  unit: string | null;
  was: string | null;
  before: string;
  beforeUnit: string | null;
  chip: { text: string; tone: SlipTone } | null;
};

export type SlipModel = {
  platform: string;
  mark: string;
  target: string | null;
  title: string;
  hero: SlipHero | null;
  why: { lead: string | null; full: string | null; markdown: string | null; about: string | null };
  flags: string[];
  chips: ProposalChip[];
  fields: ProposalField[];
  primaryLabel: string;
  steps: { sending: string; live: string };
  receipt: { title: string; rows: { label: string; before: string | null; after: string }[] };
  limitsNow: { label: string; value: string }[];
};

const AD_PLATFORM: Record<string, string> = { meta_ads: "Meta Ads", google_ads: "Google Ads" };

export function slipPlatform(decisionClass: string, body: Record<string, unknown>, appName: string): string {
  const ad = AD_PLATFORM[decisionClass.split(".")[0] ?? ""];
  if (ad) return ad;
  const app = typeof body.app_name === "string" && body.app_name.trim() ? body.app_name.trim() : null;
  if (app) return app;
  return appName && appName !== "the app" ? appName : "the app";
}

function heroOf(money: AdChangeMoney | null): SlipHero | null {
  if (!money || money.before === null || money.after === null) return null;
  const cur = money.currency;
  const d = money.delta ?? 0;
  const eyebrow =
    money.verb === "Pause" ? "Pauses it, daily budget" : money.verb === "Turn on" ? "Turns it on, daily budget" : money.verb === "Keep" ? "Daily budget" : "New daily budget";
  const chip: SlipHero["chip"] =
    d > 0
      ? { text: `+${adMoney(d, cur)}/day`, tone: "up" }
      : d < 0
        ? { text: `−${adMoney(-d, cur)}/day`, tone: "down" }
        : money.verb === "Turn on"
          ? { text: "Already on, adds nothing", tone: "flat" }
          : money.verb === "Pause"
            ? { text: "Already paused, saves nothing", tone: "flat" }
            : null;
  return {
    eyebrow,
    amount: adMoney(money.after, cur),
    unit: money.after === 0 ? null : "/day",
    was: d !== 0 ? adMoney(money.before, cur) : null,
    before: adMoney(money.before, cur),
    beforeUnit: money.before === 0 ? null : "/day",
    chip,
  };
}

function primaryOf(money: AdChangeMoney | null): string {
  if (!money) return "Approve";
  if (money.verb === "Pause" && money.delta !== 0) return "Pause it";
  if (money.verb === "Turn on" && money.delta !== 0) return "Turn it on";
  if ((money.verb === "Raise" || money.verb === "Cut") && money.after !== null) return `Approve ${adMoney(money.after, money.currency)}/day`;
  return "Approve";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function receiptOf(money: AdChangeMoney | null, fields: ProposalField[]): SlipModel["receipt"] {
  if (money && money.before !== null && money.after !== null) {
    return { title: "What changed", rows: [{ label: `${money.name} daily budget`, before: adMoney(money.before, money.currency), after: money.after === 0 ? "Paused" : `${adMoney(money.after, money.currency)}/day` }] };
  }
  if (fields.length) return { title: "What was sent", rows: fields.map((f) => ({ label: f.label, before: null, after: f.value })) };
  return { title: "What changed", rows: [] };
}

function limitsNowOf(body: Record<string, unknown>): SlipModel["limitsNow"] {
  const bc = body.budget_choice && typeof body.budget_choice === "object" ? (body.budget_choice as Record<string, unknown>) : null;
  if (!bc) return [];
  const out: SlipModel["limitsNow"] = [];
  const monthly = num(bc.monthly_usd);
  const daily = num(bc.daily_limit_usd);
  if (monthly !== null) out.push({ label: "Monthly ad budget", value: adMoney(monthly, "USD") });
  if (daily !== null) out.push({ label: "Daily ad limit", value: adMoney(daily, "USD") });
  return out;
}

export function decisionSlipModel(row: Pick<LiveDecisionRow, "decision_class" | "body">, handler: string | null, appName: string): SlipModel {
  const body = row.body ?? {};
  const v = parseProposalView(row.decision_class, handler, body);
  const money = adChangeMoney(row.decision_class, body);
  const platform = slipPlatform(row.decision_class, body, appName);
  const hero = heroOf(money);
  const flags = v.chips.filter((c) => c.tone === "bad" || c.tone === "warn").map((c) => c.label);
  const chips = v.chips.filter((c) => !(c.tone === "bad" || c.tone === "warn") && !(hero && /\/day$/.test(c.label)));
  return {
    platform,
    mark: (platform.replace(/^the /, "").trim()[0] ?? "?").toUpperCase(),
    target: money ? money.name : v.target,
    title: money ? `${money.verb} ${money.name}` : v.action,
    hero,
    why: { lead: v.lead, full: v.full, markdown: v.markdown, about: v.about },
    flags,
    chips,
    fields: v.fields,
    primaryLabel: primaryOf(money),
    steps: { sending: `Sending to ${platform}`, live: money ? `Live on ${platform}` : `Done in ${platform}` },
    receipt: receiptOf(money, v.fields),
    limitsNow: limitsNowOf(body),
  };
}

export function approvedAtLabel(approvedAt: string | null | undefined): string | null {
  const t = approvedAt ? Date.parse(approvedAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
}

export function makeReadGate() {
  let started = 0;
  let applied = 0;
  let floor = 0;
  return {
    start: (): number => ++started,
    invalidate: (): void => {
      floor = started;
    },
    accept: (gen: number): boolean => {
      if (gen <= floor || gen < applied) return false;
      applied = gen;
      return true;
    },
  };
}
