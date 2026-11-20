
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearFigures,
  pullsForFigure,
  recordFiguresFromPull,
  recordRefusedReads,
  refusedReadsFor,
  _pullCount,
} from "@/services/agents/engine/figure-ledger";
import { buildAnswerSources, seeQueryHref } from "@/services/agents/answer-sources";
import type { AccessNote } from "@/services/data-gateway/types";

const RUN = "22222222-2222-4222-8222-222222222222";
const LOG_A = "aaaaaaaa-1111-4111-8111-111111111111";
const LOG_B = "bbbbbbbb-1111-4111-8111-111111111111";
const LOG_R = "cccccccc-1111-4111-8111-111111111111";

const allowed = (over: Partial<AccessNote> = {}): AccessNote => ({
  log_id: LOG_A,
  mode: "direct",
  tables: ["bookings"],
  rows: 412,
  result: "allowed",
  ...over,
});

const RAW = '{"rows":[{"n":5344}],"truncated":true}';

beforeEach(() => clearFigures(RUN));

describe("access notes on the figure ledger", () => {
  it("indexes exactly the same figures with and without access notes", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__query");
    const plainPulls = pullsForFigure(RUN, "5344").map(({ tool, nth }) => ({ tool, nth }));
    const plainCount = _pullCount(RUN);
    clearFigures(RUN);
    recordFiguresFromPull(RUN, RAW, "operator_db__query", [allowed()]);
    expect(pullsForFigure(RUN, "5344").map(({ tool, nth }) => ({ tool, nth }))).toEqual(plainPulls);
    expect(_pullCount(RUN)).toBe(plainCount);
    expect(pullsForFigure(RUN, "5344")[0]!.access).toEqual([allowed()]);
  });

  it("keeps only allowed notes on a pull and only refused notes in the refused list", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__query", [allowed(), allowed({ result: "refused", log_id: LOG_R })]);
    expect(pullsForFigure(RUN, "5344")[0]!.access).toEqual([allowed()]);
    recordRefusedReads(RUN, [allowed(), allowed({ result: "refused", log_id: LOG_R, rows: 0 })]);
    expect(refusedReadsFor(RUN).map((n) => n.log_id)).toEqual([LOG_R]);
    clearFigures(RUN);
    expect(refusedReadsFor(RUN)).toEqual([]);
  });
});

describe("database chips and Sources lines", () => {
  it("a direct read: 'Your database: a query (call N)' with tables, rows and See query", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__query", [allowed()]);
    const r = buildAnswerSources(RUN, "You had 5,344 trips.");
    expect(r.checked[0]).toMatchObject({ kind: "pulled", source: "Your database: a query (call 1)" });
    expect(r.block).toContain(
      `1. Your database: a query (call 1) on bookings, 412 rows. [See query](/workspace?tab=brain&access=${LOG_A}#data-access)`,
    );
  });

  it("a connector read in totals-only mode says so", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__summary", [allowed({ mode: "connector", totals_only: true, rows: 1 })]);
    const r = buildAnswerSources(RUN, "You had 5,344 trips.");
    expect(r.checked[0]).toMatchObject({ source: "Your connector: a query (call 1)" });
    expect(r.block).toContain("1. Your connector: a query (call 1) on bookings, 1 row, totals only. [See query](");
  });

  it("several reads in one call sum rows, name each table once and link each query", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__codeact", [
      allowed({ tables: ["bookings", "users"], rows: 10 }),
      allowed({ log_id: LOG_B, tables: ["bookings"], rows: 5 }),
    ]);
    const r = buildAnswerSources(RUN, "You had 5,344 trips.");
    expect(r.block).toContain("on bookings, users, 15 rows. See queries: [1](");
    expect(r.block).toContain(`access=${LOG_B}`);
  });

  it("a refused read adds the summary sentence, the refusal line and the blocked-field warning", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__query", [allowed({ mode: "connector" })]);
    recordRefusedReads(RUN, [
      {
        log_id: LOG_R,
        mode: "connector",
        tables: ["users"],
        rows: 0,
        result: "refused",
        refused_by: "connector",
        reason: "users.email is blocked by this connector's rules. Rewrite the query without it.",
      },
    ]);
    const r = buildAnswerSources(RUN, "You had 5,344 trips.");
    const lines = r.block!.split("\n");
    expect(lines[1]).toBe("**Sources.** The number 5,344 came straight from data pulled in this run. 1 query was refused.");
    expect(r.block).toContain(
      `Your connector refused a query on users: users.email is blocked by this connector's rules. Nothing was sent. [See query](/workspace?tab=brain&access=${LOG_R}#data-access)`,
    );
    expect(lines.at(-1)).toBe("Not in this run's data: users.email. Your connector blocked it, so nothing about it was sent.");
    expect(r.meta.refused).toBe(1);
  });

  it("a settings refusal says 'Your settings' and still answers when no pull returned anything", () => {
    recordRefusedReads(RUN, [
      { log_id: LOG_R, mode: "direct", tables: ["users"], rows: 0, result: "refused", refused_by: "zavi", refused_rule: "settings", reason: "users.phone is hidden in What Zavi can see. Rewrite the query without it." },
      { log_id: LOG_R, mode: "direct", tables: ["users"], rows: 0, result: "refused", refused_by: "zavi", refused_rule: "settings", reason: "dup of the same log row" },
    ]);
    const r = buildAnswerSources(RUN, "I could not read that.");
    expect(r.block).toBe(
      [
        "---",
        "**Sources.** 1 query was refused.",
        "",
        `Your settings refused a query on users: users.phone is hidden in What Zavi can see. Nothing was sent. [See query](/workspace?tab=brain&access=${LOG_R}#data-access)`,
        "",
        "Not in this run's data: users.phone. Your settings hide it, so nothing about it was sent.",
      ].join("\n"),
    );
  });

  it("a refusal by Zavi's own guard says Zavi's safety check blocked it", () => {
    recordRefusedReads(RUN, [
      { log_id: null, mode: "direct", tables: ["items"], rows: 0, result: "refused", refused_by: "zavi", reason: "Zavi could not check this query: $objectToArray is not allowed by Zavi's database guard." },
    ]);
    const block = buildAnswerSources(RUN, "No figures here.").block!;
    expect(block).toContain("Zavi's safety check blocked a query on items: Zavi could not check this query: $objectToArray is not allowed by Zavi's database guard. Nothing was sent.");
    expect(block).not.toContain("Your settings");
  });

  it("markdown in a table name or reason cannot open a link", () => {
    recordRefusedReads(RUN, [
      { log_id: "not-a-log-id", mode: "direct", tables: ["x](http://evil)"], rows: 0, result: "refused", refused_by: "zavi", reason: "[click](http://evil) now" },
    ]);
    const block = buildAnswerSources(RUN, "No numbers here.").block!;
    expect(block).not.toMatch(/\]\(http/);
    expect(block).not.toContain("See query");
  });

  it("must-not-catch: other tools and pulls without notes are unchanged", () => {
    recordFiguresFromPull(RUN, RAW, "operator_db__query");
    recordFiguresFromPull(RUN, '{"open": 1287}', "github__list_open_prs");
    const r = buildAnswerSources(RUN, "5,344 trips and 1,287 PRs.");
    expect(r.block).toBe(
      [
        "---",
        "**Sources.** All 2 numbers (5,344, 1,287) came straight from data pulled in this run.",
        "",
        "1. Your database: a query returned 5,344",
        "2. GitHub: open pull requests returned 1,287",
      ].join("\n"),
    );
    expect(r.meta).not.toHaveProperty("refused");
  });

  it("seeQueryHref only links a log id", () => {
    expect(seeQueryHref(LOG_A)).toBe(`/workspace?tab=brain&access=${LOG_A}#data-access`);
    expect(seeQueryHref("../x")).toBeNull();
    expect(seeQueryHref(null)).toBeNull();
  });
});
