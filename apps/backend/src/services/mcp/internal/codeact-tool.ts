
import { z } from "zod";
import { withReadSession } from "@/services/data-gateway";
import { gatewayCtx } from "@/services/tools/operator-db/gateway-ctx";
import {
  assertReadOnlyReads,
  fanOutCaveat,
  runCodeActReads,
  CODEACT_STATEMENT_TIMEOUT_MS,
  MAX_SQL_READS,
  MAX_ROWS_PER_READ,
  type CodeActReadResult,
} from "@/services/tools/operator-db/codeact-sql";
import { resolveReportingTimezone } from "@/services/analytics/tenant-timezone";
import { redactComputed, redactDocDeep, redactValue } from "@/services/tools/operator-db/discovery/redact";
import { runCodeActPython } from "@/services/sandbox/codeact-sandbox";
import { putExploratory } from "@/services/analytics/exploratory-results";
import type { ToolSpec } from "@/services/tools/types";
import { findSimilarVerifiedQueries } from "@/services/analytics/verified-queries";
import { listActiveDataNotes } from "@/services/analytics/data-notes";

const PYTHON_ERROR_CLASSES = new Set([
  "NameError", "SyntaxError", "IndentationError", "TabError", "AttributeError", "ImportError",
  "ModuleNotFoundError", "ZeroDivisionError", "UnboundLocalError", "KeyError", "IndexError",
  "TypeError", "ValueError", "RuntimeError", "AssertionError", "RecursionError", "MemoryError",
  "OverflowError", "StopIteration", "LookupError", "ArithmeticError", "UnicodeError",
]);
const RUNNER_ERROR = "codeact_no_output";

export function pythonError(error: string | undefined, message: string | undefined): { error: string | null; message: string | null } {
  if (error == null && message == null) return { error: null, message: null };
  if (error === RUNNER_ERROR) return { error, message: "The sandbox runner produced no parseable output." };
  const cls = error && PYTHON_ERROR_CLASSES.has(error) ? error : "Exception";
  return {
    error: cls,
    message: `${cls} raised in python_code. The message is withheld because it can quote row values; check the code against each read's columns.`,
  };
}

export function redactSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, (lit) => `'${String(redactValue("", lit.slice(1, -1)))}'`);
}

export const PYTHON_CODE_MAX_BYTES = 16 * 1024;

export const codeactTool: ToolSpec = {
  name: "operator_db_codeact",
  effect: "read",
  description:
    "Run a small set of READ-ONLY SQL queries against the operator's database, then a Python compute step over the results. Use this when the rigid query tools can't express the analysis you need (joins, aggregations, derived metrics). `sql_reads` must be SELECT/CTE reads ONLY — writes/DDL are rejected. " +
    "AGGREGATE IN SQL, or add your own LIMIT: each read is cut off at " +
    `${MAX_ROWS_PER_READ} rows by the database itself, so \`SELECT *\` over a large table returns an arbitrary partial slice, NOT a sample and NOT the whole table. ` +
    "When a read comes back with `row_count_exact: false` the true total is UNKNOWN and larger than `row_count` — never report that number as a count; run `SELECT count(*)` for a real total. " +
    "A read that renames or transforms a personal-data column (name, email, address...) comes back masked (`masked` on the read; numbers survive): select such a column plainly, or count it. " +
    "Results are EXPLORATORY: for a catalog metric use growth__get_metric instead. SQL runs in the tenant's reporting time zone. " +
    "The SQL runs read-only in the backend; your `python_code` runs in an isolated sandbox with NO network and NO database access — it only sees the query result rows (exposed as the `rows` variable) and must set a JSON-serializable `result` variable. Postgres + MySQL operator DBs only. " +
    "The result may carry `verified_references` (SQL the founder confirmed for a similar question: prefer it, re-run it with this tool) and `data_notes` (the founder's corrections to how numbers are counted: apply them).",
  input_schema: z.object({
    purpose: z
      .string()
      .min(1)
      .max(500)
      .describe("One sentence: what question this query+compute answers."),
    sql_reads: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_SQL_READS)
      .describe("SELECT / WITH (CTE) read queries. No writes, no DDL, one statement each."),
    python_code: z
      .string()
      .min(1)
      .max(PYTHON_CODE_MAX_BYTES)
      .describe(
        "Python over the query rows. `rows` is a list of {index,row_count,row_count_exact,truncated,rows} per sql_reads entry — `rows` holds only the returned page, so never compute a total from len(rows) when row_count_exact is false. Set `result` (JSON-serializable). No imports of os/socket/requests/urllib/subprocess — they are blocked. No network, no DB.",
      ),
  }),
  async execute(ctx, input) {
    const args = input as { purpose: string; sql_reads: string[]; python_code: string };

    assertReadOnlyReads(args.sql_reads);

    const founderContext = Promise.all([
      findSimilarVerifiedQueries(ctx.tenant_id, args.purpose).catch(() => []),
      listActiveDataNotes(ctx.tenant_id).catch(() => null),
    ]);

    let timeZone: string | undefined;
    try {
      timeZone = (await resolveReportingTimezone(ctx.tenant_id)).tz;
    } catch {
      timeZone = undefined;
    }
    const reads = await withReadSession(
      gatewayCtx(ctx, "operator_db__codeact"),
      (session) => runCodeActReads(session, args.sql_reads, { timeZone }),
      { timeZone, int8AsNumber: true, statementTimeoutMs: CODEACT_STATEMENT_TIMEOUT_MS },
    );
    const caveats = reads
      .map((r) => fanOutCaveat(args.sql_reads[r.index] ?? "", r))
      .filter((c): c is string => c !== null);

    const sandboxReads = reads.map((r) => ({ ...r, rows: r.rows.map((row) => redactDocDeep(row)) }));
    const compute = await runCodeActPython({
      tenant_id: ctx.tenant_id,
      input: { rows: sandboxReads, reads: sandboxReads },
      python_code: args.python_code,
    });

    ctx.log("codeact ran", {
      reads: reads.length,
      compute_ok: compute.ok,
    });

    const result = compute.result === undefined ? undefined : redactComputed(compute.result);

    if (compute.ok) {
      putExploratory(ctx.tenant_id, ctx.run_id, {
        sql_reads: args.sql_reads,
        purpose: args.purpose,
        session_tz: reads[0]?.session_tz ?? null,
        caveats,
        result,
      });
    }

    const computeFailed = !compute.ok;

    const [references, notes] = await founderContext;

    return {
      ok: true,
      data: {
        exploratory: true,
        session_tz: reads[0]?.session_tz ?? null,
        ...(caveats.length ? { caveats } : {}),
        purpose: args.purpose,
        reads: reads.map((r: CodeActReadResult) => ({
          index: r.index,
          row_count: r.row_count,
          row_count_exact: r.row_count_exact,
          truncated: r.truncated,
          ...(r.masked ? { masked: r.masked } : {}),
          ...(computeFailed ? { columns: Object.keys(r.rows[0] ?? {}) } : {}),
        })),
        compute: {
          ok: compute.ok,
          result: result ?? null,
          ...pythonError(compute.error, compute.message),
          ...(computeFailed
            ? {
                retry_hint:
                  "The SQL ran; only the Python step failed, and the rows are not kept. Each read's " +
                  "`columns` above lists the column names it returned — empty when that read matched no " +
                  "rows at all, which is itself the answer to check before rewriting anything. Fix " +
                  "`python_code` against those names and call the tool again with the SAME sql_reads — do " +
                  "not change the query unless the column list shows it asked for the wrong thing. " +
                  "`rows[i]['rows']` is the list of records for sql_reads[i]; coerce numbers with " +
                  "int()/float() before any arithmetic.",
              }
            : {}),
        },
        ...(references.length
          ? {
              verified_references: references.map((r) => ({
                question: redactValue("", r.question),
                sql_reads: r.sql_reads.map(redactSqlLiterals),
                saved_at: r.created_at,
              })),
            }
          : {}),
        ...(notes === null
          ? {
              data_notes_warning:
                "The founder's data notes could not be read just now, so a saved correction may be missing. Say so in the answer.",
            }
          : notes.length
            ? { data_notes: notes.map((n) => ({ metric_id: n.metric_id, note: redactValue("", n.note_text), saved_at: n.created_at })) }
            : {}),
      },
    };
  },
};
