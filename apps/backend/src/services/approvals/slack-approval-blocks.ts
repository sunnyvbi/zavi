
import {
  decisionEvidenceSchema,
  type DecisionEvidence,
  BLAST_RADIUS,
} from "@/services/agents/decision-evidence";
import { decisionCardTitle, decisionConsequence } from "@/services/approvals/decision-copy";
import { formatMoney, normalizeCurrency } from "@/services/tools/meta-ads/write/_currency";
import { decisionHomeUrl, growthUrl, needsYouUrl } from "@/services/web-base";
import { exactActionFields } from "@/services/approvals/exact-action-view";
import { isWebOnlyApproveClass } from "@/services/approvals/money-card";
import { OVER_LIMIT_CAP_REASONS } from "@/services/tools/meta-ads/write/_cap-evaluator";

const EXACT_CARD_MAX_BLOCKS = 44;

export const SLACK_ACTION_APPROVE = "praxis_approve";
export const SLACK_ACTION_REJECT = "praxis_reject";
export const SLACK_ACTION_APPROVE_ALWAYS = "praxis_approve_always";
export const SLACK_BLOCK_ID_ACTIONS = "praxis_decision_actions";

export const SLACK_ACTION_APPROVE_ALL = "praxis_approve_all";
export const SLACK_ACTION_REJECT_ALL = "praxis_reject_all";
export const SLACK_BLOCK_ID_BATCH = "praxis_batch_actions";

export const SLACK_ACTION_EDIT = "praxis_edit";
export const EDIT_CALLBACK_ID = "edit_decision";

const EDITABLE_BUDGET_CLASSES = new Set<string>([
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget",
  "meta_ads.update_campaign_budget_review",
]);

export function buildApproveValue(decision: { id: string; decision_class: string | null; body: unknown }): string {
  if (decision.decision_class !== "social.publish.v2") return decision.id;
  const at = (decision.body as { scheduled_at?: unknown } | null)?.scheduled_at;
  return `${decision.id}|sa=${typeof at === "string" ? at : ""}`;
}

export function parseApproveValue(value: string): { decisionId: string; expected_scheduled_at?: string | null } {
  const i = value.indexOf("|sa=");
  if (i < 0) return { decisionId: value };
  const at = value.slice(i + 4);
  return { decisionId: value.slice(0, i), expected_scheduled_at: at === "" ? null : at };
}

export function isEditableBudgetClass(cls: string | null | undefined): boolean {
  if (cls?.startsWith("composio.")) return false;
  return !!cls && EDITABLE_BUDGET_CLASSES.has(cls);
}

export function readProposedDailyBudget(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const v = (body as Record<string, unknown>).daily_budget_usd;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readBodyCurrency(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const c = (body as Record<string, unknown>).currency;
  return typeof c === "string" ? c : null;
}

export function buildBatchValue(runId: string, cutoffMs: number): string {
  return `${runId}|${cutoffMs}`;
}

export function parseBatchValue(value: string): { runId: string; cutoffMs: number } {
  const [runId, cut] = String(value).split("|");
  const cutoffMs = Number(cut);
  return { runId: runId ?? "", cutoffMs: Number.isFinite(cutoffMs) ? cutoffMs : 0 };
}

export function buildBatchControlBlocks(runId: string, count: number, cutoffMs: number): unknown[] {
  const value = buildBatchValue(runId, cutoffMs);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${count} approvals queued from this run.* Approve/reject them individually above, or act on all at once:`,
      },
    },
    {
      type: "actions",
      block_id: SLACK_BLOCK_ID_BATCH,
      elements: [
        {
          type: "button",
          action_id: SLACK_ACTION_APPROVE_ALL,
          style: "primary",
          text: { type: "plain_text", text: "Approve all low-risk", emoji: true },
          value,
        },
        {
          type: "button",
          action_id: SLACK_ACTION_REJECT_ALL,
          style: "danger",
          text: { type: "plain_text", text: "Reject all", emoji: true },
          value,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "“Approve all low-risk” skips money & customer-facing actions (e.g. ad budgets) — approve those individually.",
        },
      ],
    },
  ];
}

export const DIGEST_INLINE_MAX = 15;

export type DigestItem = {
  id: string;
  theme: string;
  exception_kind: string;
};

export function buildDigestBlocks(args: {
  runId: string;
  items: DigestItem[];
  cutoffMs: number;
}): unknown[] {
  const { runId, items, cutoffMs } = args;
  const count = items.length;
  const inline = count <= DIGEST_INLINE_MAX;
  const batchValue = buildBatchValue(runId, cutoffMs);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${count} approval${count === 1 ? "" : "s"} need your call`.slice(0, 150),
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `From one PM run — ${count} roadmap exception${count === 1 ? "" : "s"} flagged. ${
            inline ? "Approve or reject each below." : "Review the full list, then act on each in the app."
          }`,
        },
      ],
    },
  ];

  if (inline) {
    for (const item of items) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${truncate(item.theme, 200)}*\n_${truncate(item.exception_kind, 80)}_` },
      });
      blocks.push({
        type: "actions",
        block_id: SLACK_BLOCK_ID_ACTIONS,
        elements: [
          {
            type: "button",
            action_id: SLACK_ACTION_APPROVE,
            style: "primary",
            text: { type: "plain_text", text: "Approve", emoji: true },
            value: item.id,
          },
          {
            type: "button",
            action_id: SLACK_ACTION_REJECT,
            style: "danger",
            text: { type: "plain_text", text: "Reject", emoji: true },
            value: item.id,
          },
        ],
      });
    }
  } else {
    const lines = items.map(
      (it) => `• *${truncate(it.theme, 160)}* — ${truncate(it.exception_kind, 80)}`,
    );
    const MAX_LIST_BLOCKS = 6;
    const CHUNK = 2800;
    const chunks: string[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    let rendered = 0;
    for (const line of lines) {
      const add = line.length + 1;
      if (bufLen + add > CHUNK && buf.length > 0) {
        chunks.push(buf.join("\n"));
        buf = [];
        bufLen = 0;
        if (chunks.length >= MAX_LIST_BLOCKS) break;
      }
      buf.push(line);
      bufLen += add;
      rendered++;
    }
    if (buf.length > 0 && chunks.length < MAX_LIST_BLOCKS) {
      chunks.push(buf.join("\n"));
    } else if (buf.length > 0) {
      rendered -= buf.length;
    }
    for (const chunk of chunks) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
    const remainder = count - rendered;
    if (remainder > 0) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `…+${remainder} more — see the app to review every item.` }],
      });
    }
  }

  const batchElements: unknown[] = [
    {
      type: "button",
      action_id: SLACK_ACTION_APPROVE_ALL,
      style: "primary",
      text: { type: "plain_text", text: "Approve all low-risk", emoji: true },
      value: batchValue,
    },
    {
      type: "button",
      action_id: SLACK_ACTION_REJECT_ALL,
      style: "danger",
      text: { type: "plain_text", text: "Reject all", emoji: true },
      value: batchValue,
    },
  ];
  if (!inline) {
    batchElements.push({
      type: "button",
      text: { type: "plain_text", text: "Review each in the app →", emoji: true },
      url: needsYouUrl(),
    });
  }
  blocks.push({ type: "actions", block_id: SLACK_BLOCK_ID_BATCH, elements: batchElements });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: inline
          ? "“Approve all low-risk” skips items that need a per-item decision — use each Approve above (or “Reject all” to clear them)."
          : "“Approve all low-risk” skips items that need a per-item decision (these do) — use the app link to Approve each, or “Reject all” to clear them.",
      },
    ],
  });

  return blocks;
}

export function buildDigestFallbackText(count: number): string {
  return `${count} PM approval${count === 1 ? "" : "s"} need your call`;
}

function isAdsDecisionClass(cls: string | null | undefined): boolean {
  return !!cls && (cls.startsWith("meta_ads.") || cls.startsWith("google_ads."));
}

function webApprovalsUrl(d?: { id: string; decision_class: string | null; home_channel?: string | null }, tenantId?: string | null): string {
  return d ? decisionHomeUrl(d, tenantId) : needsYouUrl(tenantId);
}

export type ApprovalDecisionInput = {
  id: string;
  decision_class: string | null;
  body: unknown;
  click_allowlistable?: boolean;
  dispatch_handler?: string | null;
  home_channel?: string | null;
  tenant_id?: string | null;
  web_only_note?: string | null;
};

const BLAST_EMOJI: Record<(typeof BLAST_RADIUS)[number], string> = {
  GREEN: "🟢",
  YELLOW: "🟡",
  ORANGE: "🟠",
  RED: "🔴",
};

function extractSocialPublish(
  body: unknown,
): { channel: string; text: string; scheduled_at: string | null; details: Array<{ label: string; value: string }> } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const channel = typeof b.channel === "string" ? b.channel.trim() : "";
  const payload =
    b.payload && typeof b.payload === "object" && !Array.isArray(b.payload)
      ? (b.payload as Record<string, unknown>)
      : null;
  const text = payload && typeof payload.text === "string" ? payload.text : "";
  if (!channel || !text) return null;
  const scheduled_at = typeof b.scheduled_at === "string" ? b.scheduled_at : null;
  const details: Array<{ label: string; value: string }> = [];
  for (const [key, label] of [["title", "Title"], ["board_name", "Board"], ["link", "Link"]] as const) {
    const v = payload?.[key];
    if (typeof v === "string" && v.trim()) details.push({ label, value: v.trim() });
  }
  return { channel, text, scheduled_at, details };
}

export function capFieldValue(b: Record<string, unknown>): string | null {
  if (b.over_cap !== true) return null;
  const reason = typeof b.cap_reason === "string" ? b.cap_reason : null;
  if (reason === "no_cap_configured") return "No spend limit is set, so this waits for your approval";
  if (reason === "cap_disabled") return "Spend limits are off, so this waits for your approval";
  if (reason !== null) return OVER_LIMIT_CAP_REASONS.has(reason) ? "Over your configured cap" : null;
  if (typeof b.origin === "string" && b.origin.startsWith("user_initiated")) return null;
  const to = typeof b.daily_budget_usd === "number" ? b.daily_budget_usd : null;
  const from = typeof b.expected_current_daily_budget_usd === "number" ? b.expected_current_daily_budget_usd : null;
  return to !== null && from !== null && to > from ? "Outside the automatic spend rules, so this waits for your approval" : null;
}

function extractMetaAdsSummary(
  cls: string | null | undefined,
  body: unknown,
): { headline: string; fields: Array<{ label: string; value: string }>; rationale: string; about: string } | null {
  if (!cls || !cls.startsWith("meta_ads.")) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  const about = typeof b.about === "string" ? b.about.trim() : "";
  const rationale = typeof b.rationale === "string" ? b.rationale.trim() : "";
  const level = typeof b.level === "string" ? b.level.trim() : "";
  const status = typeof b.status === "string" ? b.status.trim().toUpperCase() : "";
  const capLine = capFieldValue(b);
  const newBudget = typeof b.daily_budget_usd === "number" ? b.daily_budget_usd : null;
  const curBudget =
    typeof b.expected_current_daily_budget_usd === "number" ? b.expected_current_daily_budget_usd : null;

  const label = name || (level ? `this ${level}` : "this") ;
  const fields: Array<{ label: string; value: string }> = [];
  let headline: string;

  if (newBudget != null) {
    const m = (n: number) => formatMoney(n, typeof b.currency === "string" ? b.currency : null);
    headline = `💰 Set *${label}* budget to *${m(newBudget)}/day*`;
    fields.push({
      label: "Budget",
      value: curBudget != null ? `${m(curBudget)}/day → ${m(newBudget)}/day` : `${m(newBudget)}/day`,
    });
  } else if (status === "PAUSED") {
    headline = `⏸️ Pause *${label}*`;
    fields.push({ label: "New status", value: "PAUSED" });
  } else if (status === "ACTIVE") {
    headline = `▶️ Activate *${label}*`;
    fields.push({ label: "New status", value: "ACTIVE" });
  } else {
    headline = `*${label}* — ${cls.replace("meta_ads.", "").replace(/_/g, " ")}`;
  }
  if (level) fields.push({ label: "Level", value: level });
  if (capLine) fields.push({ label: "⚠️ Cap", value: capLine });

  if (!name && !rationale && !about && fields.length === 0) return null;
  return { headline, fields, rationale, about };
}

const GENERIC_HEADLINE_KEYS = [
  "bet_claim",
  "proposal",
  "summary",
  "objective",
  "headline",
  "title",
  "subject",
  "intent",
  "description",
];
const GENERIC_LONG_KEYS = ["rationale", "reason", "why", "draft", "plan", "details", "notes", "body_text"];
const GENERIC_SKIP_KEYS = new Set<string>([
  "decision_evidence",
  "source_signals",
  "source_run_id",
  "source_decision_id",
  "origin_decision_id",
  "dispatched_by",
  "amount_usd",
  "amount_qualitative",
  "expected_current_daily_budget_usd",
  "over_cap",
  "rendered_markdown",
  ...GENERIC_HEADLINE_KEYS,
  ...GENERIC_LONG_KEYS,
]);
const GENERIC_FIELD_LABELS: Record<string, string> = {
  to_channel: "To",
  from_channel: "From",
  confidence: "Confidence",
  cadence: "Cadence",
  schedule: "Schedule",
  frequency: "Frequency",
  target_agent_slug: "Target agent",
  channel: "Channel",
};

const PLACEHOLDER_VALUES = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "unknown",
  "tbd",
  "-",
  "—",
]);

function humanizeKey(k: string): string {
  return (
    GENERIC_FIELD_LABELS[k] ??
    k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function isInternalKey(k: string): boolean {
  if (k in GENERIC_FIELD_LABELS) return false;
  return /^_/.test(k) || /(_id|_ids|_at|_ts|_uuid)$/.test(k) || k === "id";
}

const LIST_ITEM_KEYS = [
  "title",
  "summary",
  "body",
  "name",
  "objective",
  "intent",
  "headline",
  "area",
  "bet_claim",
  "proposal",
  "target_agent_slug",
];

function summarizeListItem(item: unknown): string | null {
  if (typeof item === "string") {
    const t = item.trim();
    return t || null;
  }
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    for (const k of LIST_ITEM_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

function extractGenericSummary(body: unknown): {
  headline: string | null;
  fields: Array<{ label: string; value: string }>;
  sections: Array<{ label: string; text: string }>;
  lists: Array<{ label: string; items: string[] }>;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;

  let headline: string | null = null;
  for (const k of GENERIC_HEADLINE_KEYS) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) {
      headline = v.trim();
      break;
    }
  }

  const fields: Array<{ label: string; value: string }> = [];
  if (typeof b.amount_usd === "number" && Number.isFinite(b.amount_usd)) {
    fields.push({ label: "Amount", value: `$${b.amount_usd}/wk` });
  }
  for (const [k, v] of Object.entries(b)) {
    if (fields.length >= 8) break;
    if (GENERIC_SKIP_KEYS.has(k) || isInternalKey(k)) continue;
    let value: string | null = null;
    if (typeof v === "string") {
      const t = v.trim();
      if (t && t.length <= 120 && !PLACEHOLDER_VALUES.has(t.toLowerCase())) value = t;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      value = String(v);
    } else if (typeof v === "boolean") {
      value = v ? "yes" : "no";
    }
    if (value) fields.push({ label: truncate(humanizeKey(k), 80), value });
  }

  const sections: Array<{ label: string; text: string }> = [];
  for (const k of GENERIC_LONG_KEYS) {
    if (sections.length >= 3) break;
    const v = b[k];
    if (typeof v === "string" && v.trim()) {
      sections.push({ label: humanizeKey(k), text: v.trim() });
    }
  }

  const lists: Array<{ label: string; items: string[] }> = [];
  for (const [k, v] of Object.entries(b)) {
    if (lists.length >= 2) break;
    if (GENERIC_SKIP_KEYS.has(k) || !Array.isArray(v) || v.length === 0) continue;
    const items = v.map(summarizeListItem).filter((x): x is string => !!x);
    if (items.length === 0) continue;
    lists.push({ label: humanizeKey(k), items });
  }

  if (!headline && fields.length === 0 && sections.length === 0 && lists.length === 0) return null;
  return { headline, fields, sections, lists };
}

function extractRenderedMarkdown(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const v = (body as Record<string, unknown>).rendered_markdown;
  return typeof v === "string" && v.trim() ? v : null;
}

function mdToSlack(md: string): string {
  return md
    .replace(/^#{1,6}[ \t]*(.+?)[ \t]*$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^[ \t]*---+[ \t]*$/gm, "──────────");
}

type NotetakerAtom = {
  title: string;
  body: string;
  atom_type: string;
  owner: string;
  confidence: string;
  source_excerpt: string;
};
function extractNotetakerAtoms(
  cls: string | null | undefined,
  body: unknown,
): NotetakerAtom[] | null {
  if (cls !== "notetaker.write_atoms") return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const arr = (body as Record<string, unknown>).atoms;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const atoms = arr
    .map((a): NotetakerAtom | null => {
      if (!a || typeof a !== "object" || Array.isArray(a)) return null;
      const o = a as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      const atomBody = typeof o.body === "string" ? o.body.trim() : "";
      if (!title && !atomBody) return null;
      return {
        title,
        body: atomBody,
        atom_type: typeof o.atom_type === "string" ? o.atom_type.trim() : "",
        owner: typeof o.owner === "string" ? o.owner.trim() : "",
        confidence:
          typeof o.confidence === "string"
            ? o.confidence.trim()
            : typeof o.confidence === "number" && Number.isFinite(o.confidence)
              ? `${Math.round(o.confidence * 100)}%`
              : "",
        source_excerpt: typeof o.source_excerpt === "string" ? o.source_excerpt.trim() : "",
      };
    })
    .filter((x): x is NotetakerAtom => !!x);
  return atoms.length > 0 ? atoms : null;
}

function extractEvidence(body: unknown): DecisionEvidence | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).decision_evidence;
  if (raw === undefined || raw === null) return null;
  const parsed = decisionEvidenceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function buildApprovalBlocks(decision: ApprovalDecisionInput): unknown[] {
  const cls = decision.decision_class ?? "decision";
  if (cls === "growth.save_business_controls") return [
    { type: "section", text: { type: "mrkdwn", text: "*Business results and experiments*\nReview and edit these settings in Zavi. Only an owner or admin can save them; nothing is saved from Slack." } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Review settings in Zavi" }, url: needsYouUrl(decision.tenant_id) + `&decision=${encodeURIComponent(decision.id)}` }] },
  ];
  const consequenceBody =
    decision.body && typeof decision.body === "object" && !Array.isArray(decision.body)
      ? (decision.body as Record<string, unknown>)
      : undefined;
  const consequence = decisionConsequence(
    decision.dispatch_handler,
    decision.decision_class,
    consequenceBody,
  );
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: decisionCardTitle(cls, decision.body).slice(0, 150), emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `✅ *Approve* → ${consequence.approve}\n🚫 *Reject* → ${consequence.reject}` },
      ],
    },
  ];

  const ev = extractEvidence(decision.body);
  const exact = exactActionFields(decision.decision_class, decision.body);
  let exactTooLong = false;
  if (ev) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(ev.reason_text, 2900) },
    });

    const pct = Math.round(ev.confidence * 100);
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Blast radius*\n${BLAST_EMOJI[ev.blast_radius]} ${ev.blast_radius}` },
        { type: "mrkdwn", text: `*Reversibility*\n${ev.reversibility.replace(/_/g, " ")}` },
        { type: "mrkdwn", text: `*Confidence*\n${pct}%` },
      ],
    });

    if (ev.evidence.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Evidence*\n${bullets(ev.evidence)}` },
      });
    }
    if (ev.alternatives_considered.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Alternatives considered*\n${bullets(ev.alternatives_considered)}` },
      });
    }
  } else {
    const ads = extractMetaAdsSummary(decision.decision_class, decision.body);
    const note = ads ? null : extractNotetakerAtoms(decision.decision_class, decision.body);
    const md = ads || note ? null : extractRenderedMarkdown(decision.body);
    if (ads) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(ads.headline, 2900) } });
      if (ads.fields.length > 0) {
        blocks.push({
          type: "section",
          fields: ads.fields.slice(0, 8).map((f) => ({ type: "mrkdwn", text: `*${f.label}*\n${f.value}` })),
        });
      }
      if (ads.rationale) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Why*\n${truncate(ads.rationale, 2400)}` } });
      }
      if (ads.about) {
        blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(ads.about, 700) }] });
      }
    } else if (note) {
      const b = decision.body as Record<string, unknown>;
      const title = typeof b.title === "string" ? b.title.trim() : "";
      const meetingDate = typeof b.meeting_date === "string" ? b.meeting_date.trim() : "";
      if (title) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(title, 2900) } });
      }
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              `Approve saves all ${note.length} fact${note.length === 1 ? "" : "s"} below to your company brain, ` +
              `reject discards them.${meetingDate ? ` Meeting ${meetingDate}.` : ""}`,
          },
        ],
      });
      note.forEach((a, i) => {
        const parts: string[] = [`*${i + 1}. ${a.title || "(untitled fact)"}*`];
        if (a.body && a.body !== a.title) parts.push(a.body);
        const meta: string[] = [];
        if (a.atom_type) meta.push(a.atom_type.replace(/_/g, " "));
        if (a.owner) meta.push(`owner: ${a.owner}`);
        if (a.confidence) meta.push(`${a.confidence} confidence`);
        if (meta.length) parts.push(`_${meta.join(" · ")}_`);
        if (a.source_excerpt) parts.push(`> from transcript: “${a.source_excerpt}”`);
        const text = parts.join("\n");
        const chunks = text.match(/[\s\S]{1,2900}/g) ?? [text];
        for (const chunk of chunks) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
        }
      });
    } else if (exact) {
      const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
      outer: for (const f of exact) {
        const chars = Array.from(f.value);
        for (let i = 0; i < Math.max(chars.length, 1); i += 2_800) {
          if (blocks.length >= EXACT_CARD_MAX_BLOCKS) {
            exactTooLong = true;
            break outer;
          }
          const chunk = chars.slice(i, i + 2_800).join("");
          blocks.push({ type: "section", text: plain(i === 0 ? `${f.label}\n${chunk}` : chunk) });
        }
      }
      if (exactTooLong) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: "This is too long to show in full here. Open it in Zavi to read all of it and approve." }],
        });
      }
    } else if (md) {
      const rendered = mdToSlack(md);
      const chunks = rendered.match(/[\s\S]{1,2800}/g) ?? [];
      for (const chunk of chunks.slice(0, 6)) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
      }
      if (chunks.length > 6) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: "…truncated. Open Needs you in Zavi for the full digest." }],
        });
      }
    } else {
      const gen = extractGenericSummary(decision.body);
      if (gen) {
        if (gen.headline) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(gen.headline, 2900) } });
        }
        if (gen.fields.length > 0) {
          blocks.push({
            type: "section",
            fields: gen.fields.slice(0, 8).map((f) => ({ type: "mrkdwn", text: `*${f.label}*\n${f.value}` })),
          });
        }
        for (const sec of gen.sections) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${sec.label}*\n${truncate(sec.text, 2400)}` } });
        }
        for (const lst of gen.lists) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${lst.label}*\n${bullets(lst.items)}` } });
        }
      } else {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: "_No structured evidence attached._" },
        });
      }
    }
  }

  if (decision.decision_class === "social.publish.v2") {
    const sp = extractSocialPublish(decision.body);
    if (sp) {
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Channel*\n${sp.channel}` },
          {
            type: "mrkdwn",
            text: `*Schedule*\n${sp.scheduled_at ? sp.scheduled_at : "publish now"}`,
          },
        ],
      });
      const short = sp.details.filter((d) => d.label !== "Link");
      if (short.length) {
        blocks.push({ type: "section", fields: short.map((d) => ({ type: "mrkdwn", text: `*${d.label}*\n${d.value}` })) });
      }
      for (const d of sp.details.filter((x) => x.label === "Link")) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${d.label}*\n${d.value}` } });
      }
      const copyChunks = sp.text.match(/[\s\S]{1,2800}/g) ?? [sp.text];
      copyChunks.forEach((chunk, i) => {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: i === 0 ? `*Post copy*\n${chunk}` : chunk },
        });
      });
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Publish target resolved at approval. ⚠️ Publishes to your connected ${sp.channel} account on approval.`,
          },
        ],
      });
    }
  }

  const note = decision.web_only_note?.trim() || null;
  const webOnly = isWebOnlyApproveClass(decision.decision_class) || exactTooLong || !!note;
  if (note) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: note.slice(0, 2900) }] });
  const actionElements: unknown[] = webOnly
    ? [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: note ? "Open in Zavi" : "Open to approve", emoji: true },
          url: webApprovalsUrl(decision, decision.tenant_id),
        },
      ]
    : [
        {
          type: "button",
          action_id: SLACK_ACTION_APPROVE,
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: true },
          value: buildApproveValue(decision),
        },
      ];

  if (decision.click_allowlistable === true && !webOnly) {
    actionElements.push({
      type: "button",
      action_id: SLACK_ACTION_APPROVE_ALWAYS,
      text: { type: "plain_text", text: "Approve & always allow", emoji: true },
      value: buildApproveValue(decision),
    });
  }

  if (isAdsDecisionClass(decision.decision_class)) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Manage ads autopilot →", emoji: true },
      url: growthUrl(decision.tenant_id),
    });
  }

  if (isEditableBudgetClass(decision.decision_class) && !note) {
    actionElements.push({
      type: "button",
      action_id: SLACK_ACTION_EDIT,
      text: { type: "plain_text", text: "Edit budget", emoji: true },
      value: decision.id,
    });
  }

  actionElements.push({
    type: "button",
    action_id: SLACK_ACTION_REJECT,
    style: "danger",
    text: { type: "plain_text", text: "Reject", emoji: true },
    value: decision.id,
  });

  blocks.push({
    type: "actions",
    block_id: SLACK_BLOCK_ID_ACTIONS,
    elements: actionElements,
  });

  return blocks;
}

export function buildApprovalFallbackText(decision: ApprovalDecisionInput): string {
  return `Approval needed: ${decisionCardTitle(decision.decision_class ?? "decision", decision.body)}`;
}

export const EDIT_BUDGET_BLOCK_ID = "edit_budget_block";
export const EDIT_BUDGET_ACTION_ID = "edit_budget_value";

export function buildEditBudgetModal(
  decisionId: string,
  currentBudget: number | null,
  currency?: string | null,
): Record<string, unknown> {
  const initial = currentBudget != null ? String(currentBudget) : "";
  const symbol = normalizeCurrency(currency) === "INR" ? "₹" : "$";
  return {
    type: "modal",
    callback_id: EDIT_CALLBACK_ID,
    private_metadata: JSON.stringify({ decision_id: decisionId }),
    title: { type: "plain_text", text: "Edit budget", emoji: true },
    submit: { type: "plain_text", text: "Approve with edit", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    blocks: [
      {
        type: "input",
        block_id: EDIT_BUDGET_BLOCK_ID,
        label: { type: "plain_text", text: `Daily budget (${symbol}/day)`, emoji: true },
        element: {
          type: "plain_text_input",
          action_id: EDIT_BUDGET_ACTION_ID,
          initial_value: initial,
          placeholder: { type: "plain_text", text: "e.g. 10" },
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Approving applies this budget to your connected Meta ad set. Over-cap edits are refused at apply time.",
          },
        ],
      },
    ],
  };
}

function bullets(items: string[]): string {
  const MAX = 8;
  const shown = items.slice(0, MAX).map((i) => `• ${truncate(i, 300)}`);
  if (items.length > MAX) shown.push(`• …+${items.length - MAX} more`);
  return shown.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
