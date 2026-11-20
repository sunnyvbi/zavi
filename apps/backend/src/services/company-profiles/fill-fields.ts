import { z } from "zod";
import {
  COMPANY_FIELD_CONFIDENCES,
  COMPANY_FIELD_METHODS,
  COMPANY_FILLABLE_FIELD_KEYS,
} from "@zavi/shared";

export const COMPANY_FIELDS_FILL_SOURCE = "company_fields_fill_v1";
export const AI_ESTIMATED_SOURCE = "ai_estimated";

export type FillableSection = "icp" | "business_model";

export type FillableField = {
  key: (typeof COMPANY_FILLABLE_FIELD_KEYS)[number];
  label: string;
  section: FillableSection;
  guidance: string;
};

export const FILLABLE_FIELDS: FillableField[] = [
  {
    key: "primary_icp",
    label: "Primary ICP",
    section: "icp",
    guidance: "One sentence: who the paying customer is and the pain solved. Recorded from the company brain / who_we_serve fact; if absent, derive from customer records (who actually pays) and say so.",
  },
  {
    key: "buyer",
    label: "Buyer",
    section: "icp",
    guidance: "The role or person who decides to pay. From the brain, or from customer/booking records (e.g. the account type that completes payment).",
  },
  {
    key: "average_customer_value",
    label: "Average customer value",
    section: "icp",
    guidance: "CALCULATE: net succeeded revenue ÷ distinct paying customers over the last 90 or 365 days (Stripe charges/customers, or the operator DB payments table). Report the window and both inputs.",
  },
  {
    key: "target_industries",
    label: "Target industries",
    section: "icp",
    guidance: "Comma-separated industries actually served — from the brain, memory notes, or customer records (e.g. group customers by category/vertical column if one exists).",
  },
  {
    key: "customer_segments",
    label: "Customer segments",
    section: "icp",
    guidance: "Comma-separated segments (size, geography, use case). Prefer a live grouping of customers/bookings by plan, geography, or category over prose.",
  },
  {
    key: "personas",
    label: "Personas",
    section: "icp",
    guidance: "Comma-separated user personas evidenced in the brain or in role/user-type columns of the operator DB.",
  },
  {
    key: "avg_deal_size",
    label: "Avg deal size",
    section: "business_model",
    guidance: "CALCULATE: mean value of a completed order/booking/subscription (net of refunds) over the last 90 days — Stripe charges or invoices, or the operator DB orders/bookings table. Report window and count.",
  },
  {
    key: "gross_margin",
    label: "Gross margin",
    section: "business_model",
    guidance: "CALCULATE when the data allows: (revenue − direct costs) ÷ revenue. For a marketplace, take rate = platform fees ÷ GMV from Stripe application fees / transfers or the DB payout ledger is an acceptable proxy — label it as take rate. If neither COGS nor payouts exist anywhere, leave unfilled.",
  },
  {
    key: "net_revenue_retention",
    label: "Net revenue retention",
    section: "business_model",
    guidance: "CALCULATE from Stripe subscriptions or the DB: recurring revenue this period from customers who were paying 12 (or 3) months ago ÷ what that same cohort paid then. Say which period pair you used. If there is no recurring revenue history, leave unfilled.",
  },
  {
    key: "customer_lifetime_value",
    label: "Customer lifetime value",
    section: "business_model",
    guidance: "CALCULATE: average monthly revenue per paying customer ÷ monthly customer churn rate, where churn = customers who stopped paying (subscription canceled / no charge in the following window) ÷ customers active at the start of the window. Use Stripe subscriptions/charges or the DB. If churn cannot be measured (too few customers, no history), you may report lifetime revenue-to-date per customer instead and label it as such — never a benchmark churn.",
  },
  {
    key: "ltv_cac",
    label: "LTV : CAC",
    section: "business_model",
    guidance: "CALCULATE only when both LTV (this run) and a CAC are grounded — CAC from ad spend ÷ new paying customers over the same window (Meta/Google reads if available, or the ads_cpa metric). State both inputs; leave unfilled if either side is missing.",
  },
];

export const fillFieldKeySchema = z.enum(COMPANY_FILLABLE_FIELD_KEYS);

const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(200),
});

export const estimatedFieldSchema = z.object({
  key: fillFieldKeySchema,
  value: z.string().trim().min(1).max(1000),
  method: z.enum(COMPANY_FIELD_METHODS).default("inferred"),
  source: z.string().trim().max(300).default(""),
  formula: z.string().trim().max(500).default(""),
  inputs: z.array(inputSchema).max(12).default([]),
  assumptions: z.string().trim().max(2000).default(""),
  caveats: z.string().trim().max(2000).default(""),
  confidence: z.enum(COMPANY_FIELD_CONFIDENCES).nullable().default(null),
  evidence: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
});

export type EstimatedField = z.infer<typeof estimatedFieldSchema>;

const envelopeSchema = z.object({
  fields: z.array(estimatedFieldSchema).max(FILLABLE_FIELDS.length),
  unfilled: z
    .array(z.object({ key: fillFieldKeySchema, reason: z.string().trim().max(500) }))
    .max(FILLABLE_FIELDS.length)
    .default([]),
});

export type FillFieldsResult = z.infer<typeof envelopeSchema>;

export function fillFieldsPrompt(keys: string[], companyName: string): string {
  const wanted = FILLABLE_FIELDS.filter((field) => keys.includes(field.key));
  return [
    `Staff console request: fill the empty company-profile fields for ${companyName || "this company"}. Answer exactly as you would if the founder asked each of these in Slack.`,
    "",
    "How to work:",
    "1. memory__search first — the company brain, who_we_serve, saved analyst_metric cards and prior answers. A recorded fact wins (method \"recorded\").",
    "2. If no recorded value exists, COMPUTE it live from raw data with your read tools: stripe__list_charges / list_customers / list_invoices / search_stripe_resources, operator_db__catalog then operator_db__query / operator_db__codeact for orders, bookings, payments, users, subscriptions, payouts. Bound windows (last 90 or 365 days) and paginate sensibly. Method \"calculated\".",
    "3. Only when the raw data needed for the formula does not exist in any connected system may you fall back to a qualitative reading of the brain (method \"inferred\") — and for numeric fields you must NOT do that: leave them under `unfilled` with the concrete missing input named.",
    "4. Never use industry benchmarks, typical ratios, or numbers not returned by a tool this run. Never round a guess into a figure.",
    "5. Do not call any write tool. Do not hand off. Do not ask clarifying questions — do the best grounded job with what is connected.",
    "",
    "For every filled field return: value (short: a number with unit, a phrase, or a comma-separated list; no markdown), method, source (system + table/object + window, e.g. \"stripe charges, last 90 days\"), formula (the exact arithmetic, empty for recorded facts), inputs (each named input with the number you actually got, e.g. {\"name\":\"net revenue 90d\",\"value\":\"$57,408\"}), assumptions (definitions you chose: what counts as a customer, churn, refund handling), caveats (small samples, truncation, single-currency, proxy metrics such as take rate for margin), confidence, evidence (row counts, ids, or note titles that a reviewer could re-check).",
    "",
    "Fields to fill:",
    ...wanted.map((field) => `- ${field.key} (${field.label}): ${field.guidance}`),
    "",
    "Finish your reply with ONE JSON object wrapped in <company_fields>…</company_fields> tags, shape:",
    '{"fields":[{"key":"customer_lifetime_value","value":"$1,140","method":"calculated","source":"stripe subscriptions + charges, last 365 days","formula":"avg monthly revenue per paying customer ÷ monthly churn rate = $57 ÷ 5.0%","inputs":[{"name":"avg monthly revenue per paying customer","value":"$57"},{"name":"monthly churn rate","value":"5.0% (12 of 240 active subs canceled per month)"}],"assumptions":"customer = Stripe customer with ≥1 succeeded charge; churn = subscription canceled during the month","caveats":"single currency; 240 customers is a small base","confidence":"medium","evidence":["240 active subscriptions on 2026-07-01","1,412 charges scanned"]}],"unfilled":[{"key":"gross_margin","reason":"no COGS, payouts, or application-fee data in Stripe or the operator DB"}]}',
    "Nothing after the closing tag.",
  ].join("\n");
}

export function extractCompanyFields(outputText: unknown, requestedKeys: string[]): FillFieldsResult | null {
  if (typeof outputText !== "string") return null;
  const match = /<company_fields>([\s\S]*?)<\/company_fields>/i.exec(outputText);
  if (!match) return null;
  const raw = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return null;
  const wanted = new Set(requestedKeys);
  const seen = new Set<string>();
  const fields = parsed.data.fields.filter((field) => {
    if (!wanted.has(field.key) || seen.has(field.key)) return false;
    seen.add(field.key);
    return true;
  });
  const unfilled = parsed.data.unfilled.filter((row) => wanted.has(row.key) && !seen.has(row.key));
  return { fields, unfilled };
}
