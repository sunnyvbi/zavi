
import { z } from "zod";
import { ExpectedToolError, type ToolContext, type ToolSpec } from "@/services/tools/types";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import { isTenantOwnerOrAdmin } from "@/services/analytics/data-notes";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import type { CatalogColumn } from "@/services/tools/operator-db/types";
import { withReadSession } from "@/services/data-gateway";
import type { ReadSession } from "@/services/data-gateway/session";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { BookingEngine } from "@/services/growth/booking-metrics/config";
import { fieldInColumns, getOutcomeMap, mongoField, pgIdent } from "@/services/growth/booking-metrics/outcomes";

const MAX_CANDIDATES = 8;
export const MAX_STATUS_VALUES = 50;

const FINISH_HINT = /(complet|finish|end|close|deliver|fulfil|return|check_?out|done)/i;
const CUSTOMER_HINT = /(user|customer|buyer|client|member|account|guest|shopper|purchaser|patient|student)/i;
const REF_HINT = /(?:Id|ID|_id|Ref|_ref)$/;
const FINISHED_VALUE_HINT = /(complet|finish|done|deliver|fulfil|closed|paid|payout|success|succeed)/i;

export type BaseConfig = {
  engine: BookingEngine;
  booking_source: string;
  date_field: string;
  status_field: string | null;
  revenue_field: string | null;
  refund_field: string | null;
  refund_basis: string;
  currency: string | null;
  amount_unit: string;
  state: string;
  updated_at: string;
};

export function bookingMappingForReview(cfg: BaseConfig) {
  return {
    orders_table: cfg.booking_source,
    created_at_field: cfg.date_field,
    status_field: cfg.status_field,
    revenue_field: cfg.revenue_field,
    refund_field: cfg.refund_field,
    refunds: cfg.refund_basis === "booking_created_net" ? "subtracted from the order" : cfg.refund_basis === "none" ? "not subtracted" : "dated by refund day (not supported for ROAS)",
    currency: cfg.currency,
    amount_unit: cfg.amount_unit,
  };
}

export type StatusValues = { values: Array<{ value: string; rows: number }>; complete: boolean };

export type OutcomeFieldDeps = {
  getBase: (tenant_id: string) => Promise<BaseConfig | null>;
  getOutcomeMap: typeof getOutcomeMap;
  getCatalog: typeof getCatalog;
  readStatusValues: (ctx: ToolContext, cfg: BaseConfig) => Promise<StatusValues | null>;
  isOwnerOrAdmin: (tenant_id: string, user_id: string) => Promise<boolean>;
  confirm: (args: {
    tenant_id: string;
    completed_at_field: string;
    customer_ref_field: string;
    terminal_statuses: string[];
    confirmed_by: string;
    expected_updated_at: string;
  }) => Promise<void>;
};

const isDateType = (t: string) => /date|time/i.test(t);

export function rankFinishCandidates(columns: CatalogColumn[], createdField: string): string[] {
  return columns
    .filter((c) => isDateType(c.type) && c.name !== createdField)
    .map((c) => ({ name: c.name, score: (FINISH_HINT.test(c.name) ? 2 : 0) - c.name.split(".").length * 0.1 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.name);
}

export function rankCustomerCandidates(columns: CatalogColumn[]): string[] {
  return columns
    .filter((c) => !isDateType(c.type) && c.name !== "_id" && c.name !== "id" && (CUSTOMER_HINT.test(c.name) || REF_HINT.test(c.name)))
    .map((c) => ({
      name: c.name,
      score: (CUSTOMER_HINT.test(c.name) ? 2 : 0) + (REF_HINT.test(c.name) ? 1 : 0) - c.name.split(".").length * 0.1,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.name);
}

function tableColumns(cat: Awaited<ReturnType<typeof getCatalog>>, table: string): CatalogColumn[] | null {
  return cat?.catalog.tables.find((x) => x.name === table)?.columns ?? null;
}

async function realGetBase(tenant_id: string): Promise<BaseConfig | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("booking_metric_config")
    .select("engine, booking_source, date_field, status_field, revenue_field, refund_field, refund_basis, currency, amount_unit, state, updated_at")
    .maybeSingle();
  if (error) throw new ExpectedToolError("outcome_fields_read_failed", `The booking mapping could not be read (${error.message}).`);
  return (data as BaseConfig | null) ?? null;
}

async function realReadStatusValues(ctx: ToolContext, cfg: BaseConfig): Promise<StatusValues | null> {
  const gateway = {
    tenant_id: ctx.tenant_id,
    caller: { kind: "agent" as const, agent_slug: ctx.agent_slug ?? null, run_id: ctx.run_id ?? null, tool_name: "read_outcome_fields" },
  };
  try {
    return await withReadSession(gateway, (session) => readStatusValues(session, cfg));
  } catch {
    return null;
  }
}

export async function readStatusValues(session: ReadSession, cfg: BaseConfig): Promise<StatusValues> {
  if (!cfg.status_field) return { values: [], complete: false };
  if (cfg.engine === "mongodb") {
    const status = mongoField(cfg.status_field);
    const rows = await session.mongo().aggregate(
      cfg.booking_source,
      [{ $group: { _id: `$${status}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: MAX_STATUS_VALUES + 1 }],
      { maxTimeMS: 15_000, allowDiskUse: true, failIfTruncated: true },
    );
    const values = rows
      .filter((r) => typeof r._id === "string" && r._id.length > 0)
      .map((r) => ({ value: String(r._id), rows: Number(r.n) || 0 }));
    return { values: values.slice(0, MAX_STATUS_VALUES), complete: rows.length <= MAX_STATUS_VALUES };
  }
  if (cfg.engine === "postgres") {
    const res = await session.query(
      `SELECT (${pgIdent(cfg.status_field, "column")})::text AS v, COUNT(*)::float8 AS n FROM ${pgIdent(cfg.booking_source, "table")} GROUP BY 1 ORDER BY 2 DESC LIMIT ${MAX_STATUS_VALUES + 1}`,
      [],
    );
    const values = res.rows
      .filter((r) => typeof r.v === "string" && r.v.length > 0)
      .map((r) => ({ value: String(r.v), rows: Number(r.n) || 0 }));
    return { values: values.slice(0, MAX_STATUS_VALUES), complete: !res.truncated && res.rows.length <= MAX_STATUS_VALUES };
  }
  return { values: [], complete: false };
}

export const realOutcomeFieldDeps: OutcomeFieldDeps = {
  getBase: realGetBase,
  getOutcomeMap: (t) => getOutcomeMap(t),
  getCatalog,
  readStatusValues: realReadStatusValues,
  isOwnerOrAdmin: (t, u) => isTenantOwnerOrAdmin(t, u),
  async confirm(a) {
    const { error } = await tenantRpc(asTenantId(a.tenant_id), "confirm_booking_outcome_fields", {
      p_tenant_id: a.tenant_id,
      p_completed_at_field: a.completed_at_field,
      p_customer_ref_field: a.customer_ref_field,
      p_terminal_statuses: a.terminal_statuses,
      p_confirmed_by: a.confirmed_by,
      p_expected_updated_at: a.expected_updated_at,
    });
    if (error) {
      const changed = /changed since it was read|not confirmed/.test(error.message ?? "");
      throw new ExpectedToolError(
        changed ? "outcome_fields_mapping_changed" : "outcome_fields_save_failed",
        changed
          ? "The booking mapping changed while this was being saved. Propose the fields again and re-confirm with the founder."
          : `The fields could not be saved (${error.code ?? error.message}).`,
      );
    }
    try {
      const { inngest } = await import("@/../workers/client");
      await inngest.send({ name: "outcome-rollup.refresh.requested", data: { tenant_id: a.tenant_id } });
    } catch (e) {
      console.warn(`[outcome_fields] rollup refresh request failed for ${a.tenant_id}: ${String((e as Error)?.message ?? e)}`);
    }
  },
};

export const readOutcomeFieldsInputSchema = z.object({}).strict();

export async function runReadOutcomeFields(ctx: ToolContext, deps: OutcomeFieldDeps = realOutcomeFieldDeps) {
  const current = await deps.getOutcomeMap(ctx.tenant_id);
  const cfg = await deps.getBase(ctx.tenant_id);
  if (current.ok && cfg) {
    return {
      status: "confirmed",
      fields: {
        completed_at_field: current.map.completed_at_field,
        customer_ref_field: current.map.customer_ref_field,
        terminal_statuses: current.map.terminal_statuses,
      },
      confirmed_at: current.map.outcome_confirmed_at,
      booking_mapping: bookingMappingForReview(cfg),
      mapping_revision: cfg.updated_at,
      message:
        "Already confirmed. To change them (only if the founder says they are wrong), show the founder the booking mapping and the new values, then save with growth__confirm_outcome_fields and this mapping_revision.",
    };
  }
  if (!cfg || cfg.state !== "confirmed") {
    return {
      status: "booking_mapping_missing",
      message: "The orders/bookings table is not confirmed yet. The founder confirms it once on the Performance page (booking mapping); then propose these.",
    };
  }
  if (!cfg.status_field) {
    return {
      status: "status_field_missing",
      message: "The confirmed booking mapping has no status field. The founder adds it on the Performance page (booking mapping); then propose these.",
    };
  }
  const columns = tableColumns(await deps.getCatalog(ctx.tenant_id), cfg.booking_source);
  if (!columns) {
    return {
      status: "table_not_in_catalog",
      message: `The confirmed orders table "${cfg.booking_source}" is not in the discovered database catalog. Re-run discovery, then propose again.`,
    };
  }
  const statuses = await deps.readStatusValues(ctx, cfg);
  return {
    status: "proposal",
    table: cfg.booking_source,
    booking_mapping: bookingMappingForReview(cfg),
    mapping_revision: cfg.updated_at,
    candidates: {
      completed_at_field: rankFinishCandidates(columns, cfg.date_field),
      customer_ref_field: rankCustomerCandidates(columns),
      terminal_statuses: statuses ? statuses.values.map((s) => ({ ...s, looks_finished: FINISHED_VALUE_HINT.test(s.value) })) : null,
    },
    ...(statuses ? {} : { status_values_note: "The stored status values could not be read just now; ask the founder to name them." }),
    message:
      "Show the founder the booking mapping and these candidates in plain words: which field says when an order finished, which says who the customer is, which status values mean finished; ask them to confirm the mapping is right and that one row of this table is one order. Save only what they confirm, with growth__confirm_outcome_fields.",
  };
}

export const readOutcomeFieldsTool: ToolSpec = {
  name: "growth_read_outcome_fields",
  effect: "read",
  description:
    "Before finished-outcome CAC/ROAS (get_metric first_completed_cac / completed_net_roas) can be computed, the founder confirms facts about their orders table: when an order finished, who the customer is, which statuses mean finished, and that one row is one order. " +
    "Returns them if already confirmed, else candidates from the database catalog and the stored status values. Read-only.",
  input_schema: readOutcomeFieldsInputSchema,
  async execute(ctx, input) {
    readOutcomeFieldsInputSchema.parse(input ?? {});
    return runReadOutcomeFields(ctx);
  },
};

export const confirmOutcomeFieldsInputSchema = z
  .object({
    completed_at_field: z.string().trim().min(1).max(128).describe("The field the founder confirmed says when an order finished."),
    customer_ref_field: z.string().trim().min(1).max(128).describe("The field the founder confirmed says who the customer is."),
    terminal_statuses: z
      .array(z.string().trim().min(1).max(128))
      .min(1)
      .max(64)
      .describe("The status values the founder confirmed mean an order finished successfully."),
    one_row_is_one_order: z
      .literal(true)
      .describe("true only when the founder confirmed that each row of the orders table is one order (not one event, line item or payment)."),
    mapping_revision: z
      .string()
      .min(1)
      .max(64)
      .describe("mapping_revision from the growth__read_outcome_fields result the founder reviewed."),
    booking_mapping_confirmed: z
      .literal(true)
      .describe("true only when the founder reviewed booking_mapping from growth__read_outcome_fields in this chat and said it is right."),
  })
  .strict();

export async function runConfirmOutcomeFields(ctx: ToolContext, raw: unknown, deps: OutcomeFieldDeps = realOutcomeFieldDeps) {
  if (!isHumanAuthoredChat(ctx)) {
    throw new ExpectedToolError("outcome_fields_denied", "This can only be saved from a live chat with the founder, from what they confirmed.");
  }
  const user = ctx.actor?.actor_user_id ?? null;
  if (!user || !(await deps.isOwnerOrAdmin(ctx.tenant_id, user))) {
    throw new ExpectedToolError("outcome_fields_denied", "Only a workspace owner or admin can confirm these. Ask them to confirm in chat.");
  }
  const parsed = confirmOutcomeFieldsInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExpectedToolError(
      "outcome_fields_bad_input",
      `Not saved: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}. one_row_is_one_order and booking_mapping_confirmed must be true, and only after the founder confirmed them.`,
    );
  }
  const args = parsed.data;
  const terminal = [...new Set(args.terminal_statuses)];
  const cfg = await deps.getBase(ctx.tenant_id);
  if (cfg && cfg.updated_at !== args.mapping_revision) {
    throw new ExpectedToolError(
      "outcome_fields_mapping_changed",
      "The booking mapping changed after it was shown to the founder. Propose again (growth__read_outcome_fields) and re-confirm.",
    );
  }
  if (!cfg || cfg.state !== "confirmed" || !cfg.status_field) {
    throw new ExpectedToolError(
      "outcome_fields_no_booking_mapping",
      "The orders/bookings table (with its status field) must be confirmed first, on the Performance page.",
    );
  }
  for (const f of [args.completed_at_field, args.customer_ref_field]) {
    try {
      if (cfg.engine === "postgres") pgIdent(f, "column");
      else mongoField(f);
    } catch {
      throw new ExpectedToolError("outcome_fields_bad_field", `"${f}" is not a valid field name for this database.`);
    }
  }
  if (cfg.engine !== "mongodb" && cfg.engine !== "postgres") {
    throw new ExpectedToolError("outcome_fields_unsupported_engine", `Finished-outcome numbers support MongoDB and Postgres, not ${cfg.engine} yet.`);
  }
  if (args.completed_at_field === cfg.date_field) {
    throw new ExpectedToolError(
      "outcome_fields_same_as_created",
      `"${args.completed_at_field}" is the field the booking mapping already uses for when an order was created. Confirm the field that says when it finished.`,
    );
  }
  const columns = tableColumns(await deps.getCatalog(ctx.tenant_id), cfg.booking_source);
  if (!columns) {
    throw new ExpectedToolError("outcome_fields_not_in_catalog", `The orders table "${cfg.booking_source}" is not in the discovered catalog. Re-run discovery first.`);
  }
  for (const f of [args.completed_at_field, args.customer_ref_field]) {
    if (!fieldInColumns(cfg.engine, columns, f)) {
      throw new ExpectedToolError("outcome_fields_unknown_field", `"${f}" is not a field of "${cfg.booking_source}" in the discovered catalog.`);
    }
  }
  if (cfg.engine === "postgres") {
    const t = columns.find((c) => c.name === args.completed_at_field)?.type ?? "";
    if (!/with time zone|timestamptz/i.test(t)) {
      throw new ExpectedToolError(
        "outcome_fields_no_time_zone",
        `"${args.completed_at_field}" stores no time zone (${t || "unknown type"}), so which day an order finished on cannot be told exactly. Confirm a timestamp-with-time-zone field.`,
      );
    }
  }
  const stored = await deps.readStatusValues(ctx, cfg);
  const notes: string[] = [];
  if (stored) {
    const known = new Set(stored.values.map((s) => s.value));
    const unseen = terminal.filter((s) => !known.has(s));
    if (unseen.length === terminal.length && stored.complete) {
      notes.push(`No order has any of these statuses today (${unseen.join(", ")}), so every finished-outcome number will be zero until one does. Check the spelling with the founder.`);
    } else if (unseen.length > 0) {
      notes.push(`Not seen among the ${stored.complete ? "" : "most common "}stored statuses: ${unseen.join(", ")}.`);
    }
  } else {
    notes.push("The stored status values could not be read to double-check these; they were saved as the founder confirmed them.");
  }
  await deps.confirm({
    tenant_id: ctx.tenant_id,
    completed_at_field: args.completed_at_field,
    customer_ref_field: args.customer_ref_field,
    terminal_statuses: terminal,
    confirmed_by: user,
    expected_updated_at: args.mapping_revision,
  });
  return {
    saved: true,
    fields: { completed_at_field: args.completed_at_field, customer_ref_field: args.customer_ref_field, terminal_statuses: terminal },
    ...(notes.length ? { notes } : {}),
    booking_mapping: bookingMappingForReview(cfg),
    message: "Saved, with the founder as the confirmer of the whole booking mapping. growth__get_metric first_completed_cac and completed_net_roas now use them.",
  };
}

export const confirmOutcomeFieldsTool: ToolSpec = {
  name: "growth_confirm_outcome_fields",
  effect: "write",
  description:
    "Save the finished-order facts the founder confirmed in this chat (from growth__read_outcome_fields): completed_at_field, customer_ref_field, terminal_statuses, one_row_is_one_order, and that the booking mapping shown is right. " +
    "Only what the founder confirmed, never your own pick. Owner/admin only; fields are checked against the database catalog.",
  input_schema: confirmOutcomeFieldsInputSchema,
  async execute(ctx, input) {
    return runConfirmOutcomeFields(ctx, input);
  },
};
