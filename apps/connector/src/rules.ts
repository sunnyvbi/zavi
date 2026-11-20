import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { MAX_ROWS, type ConnectorRules, type ConnectorRulesSummary } from "@zavi/shared/db-guard";
import { atomicWrite } from "./fsutil";

export const RULES_FILE = "rules.yaml";
export const DEFAULT_MAX_ROWS = 200;
export type WhatCanLeave = ConnectorRules["what_can_leave"];

const NAME = z.string().min(1).max(256).regex(/^[^\u0000-\u001f]+$/);
const FIELD_REF = z.string().min(3).max(512).regex(/^[^\u0000-\u001f]+\.[^\u0000-\u001f]+$/);

const RulesYaml = z
  .object({
    database: z.string().max(256).optional(),
    allowed_tables: z.array(NAME).max(1000).optional(),
    allowed_collections: z.array(NAME).max(1000).optional(),
    blocked_columns: z.array(FIELD_REF).max(5000).optional(),
    blocked_fields: z.array(FIELD_REF).max(5000).optional(),
    allowed_columns: z.array(FIELD_REF).max(5000).optional(),
    max_rows_per_query: z.number().int().min(1).max(MAX_ROWS).default(DEFAULT_MAX_ROWS),
    what_can_leave: z.enum(["totals_and_counts_only", "rows_without_blocked_columns"]).default("totals_and_counts_only"),
    log: z.string().max(512).optional(),
  })
  .strict();

export type RulesState = {
  status: "missing" | "ok" | "invalid";
  rules: ConnectorRules;
  error: string | null;
  text: string | null;
};

const NOTHING: ConnectorRules = { allowed: [], blocked: [], what_can_leave: "totals_and_counts_only", max_rows: DEFAULT_MAX_ROWS };

const uniqSorted = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort();

export function parseRulesText(text: string): RulesState {
  let doc: unknown;
  try {
    doc = YAML.parse(text, { maxAliasCount: 0 });
  } catch (e) {
    return { status: "invalid", rules: NOTHING, error: `rules.yaml is not valid YAML: ${(e as Error).message.split("\n")[0]}`, text };
  }
  const parsed = RulesYaml.safeParse(doc ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { status: "invalid", rules: NOTHING, error: `rules.yaml is invalid${i?.path.length ? ` at ${i.path.join(".")}` : ""}: ${i?.message ?? "unknown error"}`, text };
  }
  const r = parsed.data;
  return {
    status: "ok",
    rules: {
      allowed: uniqSorted([...(r.allowed_tables ?? []), ...(r.allowed_collections ?? [])]),
      blocked: uniqSorted([...(r.blocked_columns ?? []), ...(r.blocked_fields ?? [])]),
      ...(r.allowed_columns && r.allowed_columns.length > 0 ? { allowed_columns: uniqSorted(r.allowed_columns) } : {}),
      what_can_leave: r.what_can_leave,
      max_rows: r.max_rows_per_query,
    },
    error: null,
    text,
  };
}

export function renderRulesYaml(rules: ConnectorRules, opts: { database: string | null; unit: "table" | "collection"; dataDir: string }): string {
  const body: Record<string, unknown> = {};
  if (opts.database) body.database = opts.database;
  body[opts.unit === "collection" ? "allowed_collections" : "allowed_tables"] = uniqSorted(rules.allowed);
  body[opts.unit === "collection" ? "blocked_fields" : "blocked_columns"] = uniqSorted(rules.blocked);
  if (rules.allowed_columns && rules.allowed_columns.length > 0) body.allowed_columns = uniqSorted(rules.allowed_columns);
  body.max_rows_per_query = rules.max_rows;
  body.what_can_leave = rules.what_can_leave;
  body.log = join(opts.dataDir, "activity.log");
  return (
    "# Zavi Connector rules. This file lives on this machine; Zavi cannot change it.\n" +
    "# Every request from Zavi is checked against it. Edits take effect on the next request.\n" +
    YAML.stringify(body, { lineWidth: 0 })
  );
}

export function rulesSummary(state: RulesState): ConnectorRulesSummary {
  return {
    allowed_tables: state.rules.allowed.slice(0, 1000),
    blocked_fields: state.rules.blocked.slice(0, 5000),
    what_can_leave: state.rules.what_can_leave,
    max_rows: state.rules.max_rows,
    ...(state.rules.allowed_columns && state.rules.allowed_columns.length > 0 ? { allowed_columns: uniqSorted(state.rules.allowed_columns).slice(0, 5000) } : {}),
  };
}

export function rulesHash(summary: ConnectorRulesSummary): string {
  const canonical = JSON.stringify({
    allowed_tables: [...summary.allowed_tables].sort(),
    blocked_fields: [...summary.blocked_fields].sort(),
    max_rows: summary.max_rows,
    what_can_leave: summary.what_can_leave,
    ...(summary.allowed_columns && summary.allowed_columns.length > 0 ? { allowed_columns: [...summary.allowed_columns].sort() } : {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class RulesFile {
  readonly path: string;
  private cache: { key: string; state: RulesState } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, RULES_FILE);
  }

  current(): RulesState {
    let key: string;
    try {
      const st = statSync(this.path);
      key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return { status: "missing", rules: NOTHING, error: null, text: null };
    }
    if (this.cache?.key === key) return this.cache.state;
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      return { status: "invalid", rules: NOTHING, error: `rules.yaml cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`, text: null };
    }
    const state = text.length > 2_000_000 ? { status: "invalid" as const, rules: NOTHING, error: "rules.yaml is too large.", text: null } : parseRulesText(text);
    this.cache = { key, state };
    return state;
  }

  save(rules: ConnectorRules, opts: { database: string | null; unit: "table" | "collection" }): RulesState {
    const text = renderRulesYaml(rules, { ...opts, dataDir: this.dataDir });
    const check = parseRulesText(text);
    if (check.status !== "ok") throw new Error(check.error ?? "rules did not validate");
    atomicWrite(this.path, text);
    this.cache = null;
    const state = this.current();
    for (const fn of this.listeners) fn();
    return state;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
}
