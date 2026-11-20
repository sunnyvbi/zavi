
import { ALL_SHAPES, ALL_TRAPS, questionsFor, type Question } from "./questions";
import { MAX_ROWS_PER_READ } from "@/services/tools/operator-db/codeact-sql";

export type BankFinding = { case_id: string; reason: string };

export function checkQuestionBank(): { total: number; findings: BankFinding[] } {
  const findings: BankFinding[] = [];
  const all: Question[] = ALL_SHAPES.flatMap((s) => questionsFor(s).questions);

  const seen = new Set<string>();
  for (const q of all) {
    if (seen.has(q.id)) findings.push({ case_id: q.id, reason: "duplicate question id" });
    seen.add(q.id);
    if (q.traps.length === 0) findings.push({ case_id: q.id, reason: "question names no trap" });

    if (q.kind === "numeric") {
      if (!Number.isFinite(q.expected)) {
        findings.push({ case_id: q.id, reason: "expected value is not finite" });
      }
      for (const w of q.knownWrongAnswers ?? []) {
        const drift =
          q.expected === 0
            ? Math.abs(w.value)
            : Math.abs(w.value - q.expected) / Math.abs(q.expected);
        if (drift <= Math.max(q.tolerance, 1e-9)) {
          findings.push({
            case_id: q.id,
            reason: `the "${w.because}" mistake now produces ${w.value}, within tolerance of the correct ${q.expected} — this question no longer catches it`,
          });
        }
      }
      if (q.unit === "percent" && (q.expected <= 1 || q.expected > 100)) {
        findings.push({ case_id: q.id, reason: `percent answer ${q.expected} is not on a 0-100 scale` });
      }
    }
  }

  const declared = new Set(all.flatMap((q) => q.traps));
  for (const trap of ALL_TRAPS) {
    if (!declared.has(trap)) {
      findings.push({ case_id: trap, reason: "trap is declared but no question carries it" });
    }
  }

  for (const shape of ALL_SHAPES) {
    const qs = questionsFor(shape).questions;
    if (!qs.some((q) => q.traps.includes("abstain_missing_field"))) {
      findings.push({ case_id: shape, reason: "shape has no question the schema cannot answer" });
    }
    if (!qs.some((q) => q.traps.includes("ambiguous_definition"))) {
      findings.push({ case_id: shape, reason: "shape has no ambiguously-worded question" });
    }
  }

  for (const shape of ALL_SHAPES) {
    const a = JSON.stringify(questionsFor(shape).dataset.tables);
    const b = JSON.stringify(questionsFor(shape).dataset.tables);
    if (a !== b) findings.push({ case_id: shape, reason: "fixture is not deterministic across builds" });
  }

  const bigTables: [string, string][] = [
    ["ecommerce", "web_sessions"],
    ["consumer", "app_events"],
  ];
  for (const [shape, table] of bigTables) {
    const rows = questionsFor(shape).dataset.tables.find((t) => t.name === table)?.rows.length ?? 0;
    if (rows <= MAX_ROWS_PER_READ) {
      findings.push({
        case_id: `${shape}.${table}`,
        reason: `only ${rows} rows — no longer exceeds the ${MAX_ROWS_PER_READ}-row read cap, so the truncation trap is inert`,
      });
    }
  }

  for (const q of all) {
    if (q.kind !== "numeric") continue;
    if ((q.knownWrongAnswers ?? []).length === 0) {
      findings.push({ case_id: q.id, reason: "numeric question names no wrong answer, so a miss cannot be diagnosed" });
    }
  }

  findings.push(...checkTrapLiveness());

  findings.push(...checkNothingInTheFuture());

  return { total: all.length, findings };
}

function checkNothingInTheFuture(): BankFinding[] {
  const out: BankFinding[] = [];
  for (const shape of ALL_SHAPES) {
    const ds = questionsFor(shape).dataset;
    const anchor = new Date(ds.anchorIso).getTime();
    for (const t of ds.tables) {
      const tsCols = t.columns.filter(
        (c) => (c.type === "timestamp" || c.type === "date") && c.forwardLooking !== true,
      );
      for (const col of tsCols) {
        const ahead = t.rows.filter((r) => {
          const v = r[col.name];
          return v instanceof Date && v.getTime() > anchor;
        }).length;
        if (ahead > 0) {
          out.push({
            case_id: `${shape}.${t.name}.${col.name}`,
            reason: `${ahead} row(s) dated after the dataset anchor ${ds.anchorIso} — an event that has not happened yet makes the question ambiguous`,
          });
        }
      }
    }
  }
  return out;
}

function checkTrapLiveness(): BankFinding[] {
  const out: BankFinding[] = [];
  const rowsOf = (shape: string, table: string): Record<string, unknown>[] =>
    questionsFor(shape).dataset.tables.find((t) => t.name === table)?.rows ?? [];

  const invoices = rowsOf("saas", "invoices");
  const paidThenVoided = invoices.filter((i) => i.voided_at !== null && i.paid_at !== null).length;
  if (paidThenVoided === 0) {
    out.push({
      case_id: "saas.invoices",
      reason:
        "no invoice is both paid and voided, so a `voided_at IS NULL` filter cannot change any answer — the voided_rows trap is inert",
    });
  }

  const listings = rowsOf("marketplace", "listings");
  const deletedButActive = listings.filter((l) => l.deleted_at !== null && l.status === "active").length;
  const liveButNotActive = listings.filter((l) => l.deleted_at === null && l.status !== "active").length;
  if (deletedButActive === 0 || liveButNotActive === 0) {
    out.push({
      case_id: "marketplace.listings",
      reason:
        "soft-delete and status never disagree, so filtering on either one alone gives the right answer — the soft_delete trap is inert",
    });
  }

  const bookings = rowsOf("marketplace", "bookings");
  const casings = new Set(bookings.map((b) => String(b.status)));
  const lowered = new Set([...casings].map((c) => c.toLowerCase()));
  if (casings.size === lowered.size) {
    out.push({
      case_id: "marketplace.bookings.status",
      reason: "every status is written in one casing — the status_enum_variants trap is inert",
    });
  }

  const subs = rowsOf("saas", "subscriptions");
  const events = rowsOf("saas", "subscription_events");
  const cancelled = new Set(events.filter((e) => e.type === "cancel").map((e) => e.account_id));
  const hiddenChurn = subs.filter((x) => cancelled.has(x.account_id) && x.canceled_at === null).length;
  if (hiddenChurn === 0) {
    out.push({
      case_id: "saas.subscriptions",
      reason:
        "no account cancelled and was won back, so subscriptions.canceled_at tells the same story as the event log — the event_log_vs_mutable_status trap is inert",
    });
  }

  const accounts = rowsOf("saas", "accounts");
  const q2Start = new Date("2026-04-01T00:00:00.000Z").getTime();
  const q2End = new Date("2026-07-01T00:00:00.000Z").getTime();
  const cohortIds = new Set(
    accounts
      .filter((a) => {
        const t = (a.created_at as Date).getTime();
        return a.is_internal !== true && a.deleted_at === null && t >= q2Start && t < q2End;
      })
      .map((a) => a.id),
  );
  const createdById = new Map(accounts.map((a) => [a.id, a.created_at as Date]));
  const lateConverts = events.filter((e) => {
    if (e.type !== "start" || !cohortIds.has(e.account_id)) return false;
    const created = createdById.get(e.account_id);
    if (!created) return false;
    return (e.at as Date).getTime() - created.getTime() > 30 * 86_400_000;
  }).length;
  if (lateConverts === 0) {
    out.push({
      case_id: "saas.subscription_events",
      reason:
        "every Q2-cohort subscription starts within 30 days of signup, so 'converted within 30 days' collapses into 'ever converted' — the window is not being tested",
    });
  }

  const users = rowsOf("marketplace", "users");
  const testIds = new Set(users.filter((u) => u.is_test === true).map((u) => u.id));
  const testBookings = rowsOf("marketplace", "bookings").filter((b) => testIds.has(b.guest_id)).length;
  if (testBookings === 0) {
    out.push({
      case_id: "marketplace.users",
      reason: "no test account ever booked, so excluding them changes nothing — the test_rows_excluded trap is inert",
    });
  }

  const staff = rowsOf("agency", "staff");
  const augLeavers = staff.filter((s) => {
    const left = s.left_at as Date | null;
    return left instanceof Date && left >= new Date("2026-08-01T00:00:00.000Z") && left < new Date("2026-09-01T00:00:00.000Z");
  }).length;
  if (augLeavers === 0) {
    out.push({
      case_id: "agency.staff",
      reason: "nobody left during August, so giving everyone the full month of available hours is not a mistake — the utilisation denominator trap is inert",
    });
  }
  const contractors = staff.filter((s) => s.is_contractor === true).length;
  if (contractors === 0) {
    out.push({ case_id: "agency.staff.is_contractor", reason: "no contractors, so excluding them changes nothing" });
  }

  const timeEntries = rowsOf("agency", "time_entries");
  if (!timeEntries.some((e) => Number(e.minutes) % 60 !== 0)) {
    out.push({
      case_id: "agency.time_entries.minutes",
      reason: "every entry is a whole number of hours, so reading minutes as hours is harder to catch than it should be",
    });
  }
  const projects = rowsOf("agency", "projects");
  const nonTm = new Set(projects.filter((p) => p.billing_type !== "time_and_materials").map((p) => p.id));
  if (!timeEntries.some((e) => e.billable === true && nonTm.has(e.project_id))) {
    out.push({
      case_id: "agency.projects.billing_type",
      reason: "no billable time is logged against retainer or fixed-fee projects, so billing every billable hour gives the right answer anyway",
    });
  }

  const entries = rowsOf("ledger", "ledger_entries");
  const postedTotal = entries
    .filter((e) => e.posted_at !== null)
    .reduce((n, e) => n + Number(e.amount_cents), 0);
  if (postedTotal !== 0) {
    out.push({
      case_id: "ledger.ledger_entries",
      reason: `posted entries sum to ${postedTotal}, not zero — the ledger does not balance, so every question built on it is measuring a broken fixture`,
    });
  }
  const transfers = rowsOf("ledger", "transfers");
  if (!transfers.some((t) => t.reversal_of_id !== null)) {
    out.push({ case_id: "ledger.transfers", reason: "nothing was ever reversed, so counting reversals as new volume is not a mistake" });
  }
  if (!transfers.some((t) => t.status === "pending")) {
    out.push({ case_id: "ledger.transfers.pending", reason: "no pending transfers, so 'a transfer with no ledger rows' cannot be tested" });
  }
  const disputes = rowsOf("ledger", "disputes");
  if (!disputes.some((d) => d.outcome === "won") || !disputes.some((d) => d.outcome === "lost")) {
    out.push({ case_id: "ledger.disputes", reason: "disputes do not include both won and lost, so 'a dispute we won moves no money' is untested" });
  }

  const shipments = rowsOf("logistics", "shipments");
  const lateAndMissing = shipments.filter(
    (s) => s.delivered_at === null && (s.promised_at as Date) < new Date("2026-09-01T12:00:00.000Z"),
  ).length;
  if (lateAndMissing === 0) {
    out.push({
      case_id: "logistics.shipments",
      reason: "every undelivered shipment is still within its promise, so dropping undelivered parcels from the denominator would not change the rate — the survivorship trap is inert",
    });
  }
  const scans = rowsOf("logistics", "scans");
  const byKey = new Map<string, number>();
  for (const sc of scans) {
    const k = `${sc.shipment_id}|${sc.event}|${(sc.scanned_at as Date).toISOString()}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  if (![...byKey.values()].some((n) => n > 1)) {
    out.push({ case_id: "logistics.scans", reason: "no duplicated scans, so counting scan rows instead of parcels is not a mistake" });
  }
  if (!scans.some((sc) => sc.event === "with_courier") || !scans.some((sc) => sc.event === "out_for_delivery")) {
    out.push({ case_id: "logistics.scans.event", reason: "only one name is used for the out-for-delivery step, so the event-name-variant trap is inert" });
  }

  const agTime = rowsOf("agency", "time_entries");
  const agProjects = new Map(rowsOf("agency", "projects").map((p) => [p.id, p]));
  const agClients = new Map(rowsOf("agency", "clients").map((c) => [c.id, c]));
  const minutesByClient = (includeInternal: boolean) => {
    const m = new Map<unknown, number>();
    for (const e of agTime) {
      if (e.billable !== true) continue;
      const pr = agProjects.get(e.project_id);
      const cl = pr ? agClients.get(pr.client_id) : undefined;
      if (!cl) continue;
      if (!includeInternal && cl.is_internal === true) continue;
      m.set(cl.id, (m.get(cl.id) ?? 0) + Number(e.minutes));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  if (JSON.stringify(minutesByClient(true)) === JSON.stringify(minutesByClient(false))) {
    out.push({
      case_id: "agency.clients.is_internal",
      reason: "excluding internal clients does not change the top client, so AG5's instruction to leave them out is inert",
    });
  }

  const strayEntries = agTime.filter((e) => {
    const pr = agProjects.get(e.project_id);
    if (!pr) return true;
    const on = e.worked_on as Date;
    return on < (pr.started_at as Date) || (pr.ended_at !== null && on > (pr.ended_at as Date));
  }).length;
  if (strayEntries > 0) {
    out.push({
      case_id: "agency.time_entries.project_id",
      reason: `${strayEntries} entries are logged outside their project's start/end, so "only count open projects" is a second defensible reading`,
    });
  }

  const shipmentRows = rowsOf("logistics", "shipments");
  const onTimeRows = shipmentRows.filter(
    (s) => s.delivered_at !== null && (s.delivered_at as Date) <= (s.promised_at as Date),
  );
  const exactlyOnDeadline = onTimeRows.filter(
    (s) => (s.delivered_at as Date).getTime() === (s.promised_at as Date).getTime(),
  ).length;
  if (onTimeRows.length > 0 && exactlyOnDeadline === onTimeRows.length) {
    out.push({
      case_id: "logistics.shipments.delivered_at",
      reason: "every on-time delivery lands exactly on the promised millisecond, so a strict < returns 0% and the boundary is not really being tested",
    });
  }
  if (exactlyOnDeadline === 0) {
    out.push({
      case_id: "logistics.shipments.promised_at",
      reason: "no delivery lands exactly on the deadline, so <= and < agree and the boundary is untested",
    });
  }

  const logiCustomers = rowsOf("logistics", "customers");
  const logiTestIds = new Set(logiCustomers.filter((c) => c.is_test === true).map((c) => c.id));
  const testShipments = shipmentRows.filter((s) => logiTestIds.has(s.customer_id)).length;
  if (testShipments === 0) {
    out.push({ case_id: "logistics.customers.is_test", reason: "no test customer has a shipment, so excluding them changes nothing" });
  }

  return out;
}
