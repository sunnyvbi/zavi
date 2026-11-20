
import { buildAgency } from "./fixtures/agency";
import { buildLedger } from "./fixtures/ledger";
import { buildLogistics } from "./fixtures/logistics";
import { inRange, localMonthRange } from "./fixtures/time";
import type { Dataset } from "./fixtures/types";
import type { Question } from "./questions";

const round2 = (n: number) => Math.round(n * 100) / 100;

function distinguishable(
  expected: number,
  tolerance: number,
  entries: { value: number; because: string }[],
): { value: number; because: string }[] {
  return entries.filter((e) => {
    const drift = expected === 0 ? Math.abs(e.value) : Math.abs(e.value - expected) / Math.abs(expected);
    return drift > Math.max(tolerance, 1e-9);
  });
}
const rows = (ds: Dataset, name: string) =>
  ds.tables.find((t) => t.name === name)!.rows as Record<string, any>[];
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

const AUG = (ds: Dataset) => localMonthRange(2026, 8, ds.timezone);

function agencyQuestions(ds: Dataset): Question[] {
  const [augStart, augEnd] = AUG(ds);
  const staff = rows(ds, "staff");
  const clients = rows(ds, "clients");
  const projects = rows(ds, "projects");
  const entries = rows(ds, "time_entries");
  const anchor = new Date(ds.anchorIso);

  const staffById = new Map(staff.map((s) => [s.id, s]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const augEntries = entries.filter((e) => inRange(e.worked_on, augStart, augEnd));
  const billableMinutes = augEntries
    .filter((e) => e.billable === true)
    .reduce((s, e) => s + Number(e.minutes), 0);
  const allMinutes = augEntries.reduce((s, e) => s + Number(e.minutes), 0);

  const isInternalProject = (projectId: unknown): boolean => {
    const pr = projectById.get(projectId);
    return pr ? clientById.get(pr.client_id)?.is_internal === true : false;
  };
  const tmBillableAug = augEntries.filter(
    (e) => e.billable === true && projectById.get(e.project_id)?.billing_type === "time_and_materials",
  );
  const tmBilledUsd =
    tmBillableAug
      .filter((e) => !isInternalProject(e.project_id))
      .reduce((s, e) => s + (Number(e.minutes) / 60) * Number(e.billed_rate_cents_per_hour), 0) / 100;
  const tmBilledInclInternalUsd =
    tmBillableAug.reduce((s, e) => s + (Number(e.minutes) / 60) * Number(e.billed_rate_cents_per_hour), 0) / 100;
  const allBillableAsIfTmUsd =
    augEntries
      .filter((e) => e.billable === true && e.billed_rate_cents_per_hour !== null)
      .reduce((s, e) => s + (Number(e.minutes) / 60) * Number(e.billed_rate_cents_per_hour), 0) / 100;

  const employedNow = staff.filter(
    (s) => s.is_contractor !== true && (s.left_at === null || asDate(s.left_at) > anchor),
  ).length;
  const everyoneNow = staff.filter((s) => s.left_at === null || asDate(s.left_at) > anchor).length;
  const employeesIgnoringLeavers = staff.filter((s) => s.is_contractor !== true).length;

  const workdaysInAug: Date[] = [];
  for (let d = new Date(augStart); d < augEnd; d = new Date(d.getTime() + 86_400_000)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) workdaysInAug.push(new Date(d));
  }
  const availableMinutes = staff
    .filter((s) => s.is_contractor !== true)
    .reduce((sum, s) => {
      const hired = asDate(s.hired_at);
      const left = s.left_at === null ? null : asDate(s.left_at);
      const days = workdaysInAug.filter(
        (d) => hired <= d && (left === null || d <= left),
      ).length;
      return sum + days * 8 * 60;
    }, 0);
  const employeeBillableMinutes = augEntries
    .filter((e) => e.billable === true && staffById.get(e.staff_id)?.is_contractor !== true)
    .reduce((s, e) => s + Number(e.minutes), 0);
  const utilisation = (employeeBillableMinutes / availableMinutes) * 100;

  const availableIgnoringLeaveDates = staff
    .filter((s) => s.is_contractor !== true)
    .reduce((sum, s) => {
      const hired = asDate(s.hired_at);
      return sum + workdaysInAug.filter((d) => hired <= d).length * 8 * 60;
    }, 0);

  const employeeOnlyBillableHours = augEntries
    .filter((e) => e.billable === true && staffById.get(e.staff_id)?.is_contractor !== true)
    .reduce((s, e) => s + Number(e.minutes), 0) / 60;
  const employeeOnlyAllMinutes = augEntries
    .filter((e) => staffById.get(e.staff_id)?.is_contractor !== true)
    .reduce((s, e) => s + Number(e.minutes), 0);
  const employeeOnlyNonBillablePct =
    ((employeeOnlyAllMinutes -
      augEntries
        .filter((e) => e.billable === true && staffById.get(e.staff_id)?.is_contractor !== true)
        .reduce((s, e) => s + Number(e.minutes), 0)) /
      employeeOnlyAllMinutes) *
    100;
  const intDivTmUsd =
    tmBillableAug
      .filter((e) => !isInternalProject(e.project_id))
      .reduce((s, e) => s + Math.floor(Number(e.minutes) / 60) * Number(e.billed_rate_cents_per_hour), 0) / 100;

  const byClient = new Map<unknown, number>();
  for (const e of augEntries) {
    if (e.billable !== true) continue;
    const p = projectById.get(e.project_id);
    const c = p ? clientById.get(p.client_id) : undefined;
    if (!c || c.is_internal === true) continue;
    byClient.set(c.id, (byClient.get(c.id) ?? 0) + Number(e.minutes));
  }
  const topClientMinutes = [...byClient.values()].sort((a, b) => b - a)[0];
  const byClientInclInternal = new Map<unknown, number>();
  for (const e of augEntries) {
    if (e.billable !== true) continue;
    const p = projectById.get(e.project_id);
    if (!p) continue;
    byClientInclInternal.set(p.client_id, (byClientInclInternal.get(p.client_id) ?? 0) + Number(e.minutes));
  }
  const topClientMinutesInclInternal = [...byClientInclInternal.values()].sort((a, b) => b - a)[0];

  return [
    {
      id: "AG1",
      shape: "agency",
      kind: "numeric",
      prompt: "How many billable hours were logged in August 2026, by everyone who logs time — employees and " +
        "contractors alike?",
      traps: ["minor_units", "segmentation"],
      expected: round2(billableMinutes / 60),
      unit: "count",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: billableMinutes, because: "reported minutes as hours — time is stored in minutes, so this is 60x too high" },
        { value: round2(allMinutes / 60), because: "counted non-billable time as billable" },
        { value: round2(employeeOnlyBillableHours), because: "left contractors out, though the question asks for everyone who logs time" },
      ],
    },
    {
      id: "AG2",
      shape: "agency",
      kind: "numeric",
      prompt:
        "What did we bill our clients for time-and-materials work in August 2026, in dollars? Retainer and " +
        "fixed-fee projects are not billed from logged time, and our own internal projects are not billed " +
        "to anyone.",
      traps: ["minor_units", "segmentation"],
      expected: round2(tmBilledUsd),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        {
          value: round2(allBillableAsIfTmUsd),
          because: "billed every billable hour at its rate, including hours logged to retainer and fixed-fee projects, which are not billed that way",
        },
        { value: round2(tmBilledUsd * 60), because: "treated the minutes column as hours" },
        {
          value: round2(intDivTmUsd),
          because: "wrote minutes / 60 against an integer column on Postgres, where integer division truncates — every entry under an hour became zero",
        },
        {
          value: round2(tmBilledInclInternalUsd),
          because: "billed our own internal projects to somebody — internal work is not billed to anyone",
        },
      ],
    },
    {
      id: "AG3",
      shape: "agency",
      kind: "numeric",
      prompt: "How many employees do we have on staff right now? Contractors are not employees.",
      traps: ["soft_delete"],
      expected: employedNow,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: employeesIgnoringLeavers, because: "counted everyone who was ever an employee, including the ones who have left" },
        { value: everyoneNow, because: "counted contractors as employees" },
        { value: staff.length, because: "counted every staff row" },
      ],
    },
    {
      id: "AG4",
      shape: "agency",
      kind: "numeric",
      prompt:
        "What was employee utilisation in August 2026 — billable hours as a percentage of available hours? " +
        "A working day is 8 hours, nobody works weekends, contractors do not count, and somebody who left " +
        "partway through the month was only available up to their last day.",
      traps: ["cohort_denominator", "minor_units", "event_log_vs_mutable_status"],
      expected: round2(utilisation),
      unit: "percent",
      tolerance: 0.005,
      knownWrongAnswers: [
        {
          value: round2((employeeBillableMinutes / availableIgnoringLeaveDates) * 100),
          because: "gave everyone the full month of available hours, including the people who left partway through",
        },
        { value: 0, because: "divided integer minutes on Postgres, where integer division truncates the ratio to zero" },
      ],
    },
    {
      id: "AG5",
      shape: "agency",
      kind: "numeric",
      prompt:
        "Which client took the most billable hours in August 2026, and how many? Answer with the hours. " +
        "Leave out our own internal projects.",
      traps: ["segmentation", "test_rows_excluded", "minor_units"],
      expected: round2(topClientMinutes / 60),
      unit: "count",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(topClientMinutesInclInternal / 60), because: "included our own internal projects in the ranking" },
        { value: topClientMinutes, because: "reported minutes as hours" },
      ],
    },
    {
      id: "AG6",
      shape: "agency",
      kind: "numeric",
      prompt: "What share of all the time logged in August 2026 — employees and contractors alike — was " +
        "non-billable? Answer as a percentage.",
      traps: ["cohort_denominator"],
      expected: round2(((allMinutes - billableMinutes) / allMinutes) * 100),
      unit: "percent",
      tolerance: 0.005,
      knownWrongAnswers: [
        { value: round2(employeeOnlyNonBillablePct), because: "left contractors out, though the question asks for all logged time" },
        { value: 0, because: "divided integer minutes on Postgres, where the truncation makes every ratio under an hour zero" },
      ],
    },
    {
      id: "AG7",
      shape: "agency",
      kind: "narrative",
      prompt: "How much did we make last month?",
      traps: ["ambiguous_definition"],
      mustAssert: [
        "either asks ONE clarifying question, or states explicitly which revenue definition it used",
        "recognises that the three billing types are not summed the same way — time-and-materials comes from logged billable hours, while retainers and fixed fees do not",
      ],
      mustNotAssert: [
        "a single dollar figure derived from billable hours alone, presented as the whole revenue",
      ],
    },
    {
      id: "AG8",
      shape: "agency",
      kind: "narrative",
      prompt: "Which of our clients came to us through a referral?",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: nothing on the clients table records how a client was acquired — no source, referrer or channel field",
      ],
      mustNotAssert: ["a list of clients presented as referrals", "a claim that the database is not connected"],
    },
  ];
}

function ledgerQuestions(ds: Dataset): Question[] {
  const [augStart, augEnd] = AUG(ds);
  const accounts = rows(ds, "accounts");
  const transfers = rows(ds, "transfers");
  const entries = rows(ds, "ledger_entries");
  const fees = rows(ds, "transfer_fees");
  const disputes = rows(ds, "disputes");

  const FEE_ACCOUNT = accounts.find((a) => a.kind === "fee")!.id;
  const customerAccounts = new Set(accounts.filter((a) => a.kind === "customer").map((a) => a.id));

  const feeAccountAug = entries.filter(
    (e) => e.account_id === FEE_ACCOUNT && e.posted_at !== null && inRange(e.posted_at, augStart, augEnd),
  );
  const netFeeRevenue = feeAccountAug.reduce((s, e) => s + Number(e.amount_cents), 0) / 100;
  const grossFeesBooked =
    fees.filter((f) => inRange(f.posted_at, augStart, augEnd)).reduce((s, f) => s + Number(f.amount_cents), 0) /
    100;

  const augTransfers = transfers.filter((t) => inRange(t.created_at, augStart, augEnd));
  const settledOriginals = augTransfers.filter(
    (t) => t.status === "settled" && t.reversal_of_id === null,
  );
  const settledVolume = settledOriginals.reduce((s, t) => s + Number(t.gross_cents), 0) / 100;
  const everyTransferVolume = augTransfers.reduce((s, t) => s + Number(t.gross_cents), 0) / 100;
  const pendingFailedIncluded =
    augTransfers
      .filter((t) => t.reversal_of_id === null)
      .reduce((s, t) => s + Number(t.gross_cents), 0) / 100;
  const settledInclReversals =
    augTransfers.filter((t) => t.status === "settled").reduce((s, t) => s + Number(t.gross_cents), 0) / 100;

  const pendingNoEntries = augTransfers.filter((t) => t.status === "pending").length;
  const failedAug = augTransfers.filter((t) => t.status === "failed").length;

  const lostAug = disputes.filter(
    (d) => d.outcome === "lost" && d.resolved_at !== null && inRange(d.resolved_at, augStart, augEnd),
  );
  const chargebackUsd = lostAug.reduce((s, d) => s + Number(d.amount_cents), 0) / 100;
  const allResolvedAug = disputes.filter(
    (d) => d.resolved_at !== null && inRange(d.resolved_at, augStart, augEnd),
  );
  const allResolvedUsd = allResolvedAug.reduce((s, d) => s + Number(d.amount_cents), 0) / 100;
  const lostTransferIds = new Set(lostAug.map((d) => d.transfer_id));
  const lostFeeOnlyUsd =
    fees.filter((f) => lostTransferIds.has(f.transfer_id)).reduce((s, f) => s + Number(f.amount_cents), 0) / 100;

  const sendersAug = new Set(
    entries
      .filter(
        (e) =>
          e.posted_at !== null &&
          inRange(e.posted_at, augStart, augEnd) &&
          Number(e.amount_cents) < 0 &&
          customerAccounts.has(e.account_id),
      )
      .map((e) => e.account_id),
  ).size;

  const reversalIds = new Set(transfers.filter((t) => t.reversal_of_id !== null).map((t) => t.id));
  const sendersExcludingClawbacks = new Set(
    entries
      .filter(
        (e) =>
          e.posted_at !== null &&
          inRange(e.posted_at, augStart, augEnd) &&
          Number(e.amount_cents) < 0 &&
          customerAccounts.has(e.account_id) &&
          !reversalIds.has(e.transfer_id),
      )
      .map((e) => e.account_id),
  ).size;

  return [
    {
      id: "LG1",
      shape: "ledger",
      kind: "numeric",
      prompt:
        "What was Tallow's own fee income in August 2026, in dollars? Use what actually landed in the fee " +
        "account that month, so anything reversed or charged back nets off.",
      traps: ["minor_units", "refunds_netted"],
      expected: round2(netFeeRevenue),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        {
          value: round2(grossFeesBooked),
          because: "summed the fees charged and ignored the fee credits that reversals and lost disputes post back",
        },
      ],
    },
    {
      id: "LG2",
      shape: "ledger",
      kind: "numeric",
      prompt:
        "What was the gross value of transfers that SETTLED in August 2026, in dollars? Count each original " +
        "transfer once; a reversal is not new volume, and pending or failed transfers did not move money.",
      traps: ["refunds_netted", "distinct_vs_rows"],
      expected: round2(settledVolume),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(pendingFailedIncluded), because: "counted pending and failed transfers as money that moved" },
        { value: round2(everyTransferVolume), because: "counted every transfer row in the month — pending, failed and reversals alike" },
        { value: round2(settledInclReversals), because: "counted reversal transfers as new volume, double counting the money they undo" },
      ],
    },
    {
      id: "LG3",
      shape: "ledger",
      kind: "numeric",
      prompt: "How many transfers created in August 2026 are still pending, with nothing posted to the ledger?",
      traps: ["event_log_vs_mutable_status"],
      expected: pendingNoEntries,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: pendingNoEntries + failedAug, because: "counted failed transfers as pending — failed transfers do have ledger rows, they were just never posted" },
      ],
    },
    {
      id: "LG4",
      shape: "ledger",
      kind: "numeric",
      prompt:
        "What was the total value of the transfers that were charged back in August 2026, in dollars? Use " +
        "the transfer amount, not Tallow's fee on it. A dispute we won did not move any money.",
      traps: ["refunds_netted", "minor_units"],
      expected: round2(chargebackUsd),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(allResolvedUsd), because: "counted every resolved dispute, including the ones we won, which move no money" },
        {
          value: round2(lostFeeOnlyUsd),
          because: "reported Tallow's own fee loss rather than the value of the transfers charged back — a defensible number, but not the one asked for",
        },
      ],
    },
    {
      id: "LG5",
      shape: "ledger",
      kind: "numeric",
      prompt:
        "How many different customer accounts had money taken OUT of them in August 2026? Count any posted " +
        "debit on a customer account, including the clawback a reversal posts against the recipient.",
      traps: ["distinct_vs_rows"],
      expected: sendersAug,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        {
          value: sendersExcludingClawbacks,
          because: "counted only the accounts that initiated a transfer, missing the recipients a reversal claws money back from",
        },
      ],
    },
    {
      id: "LG6",
      shape: "ledger",
      kind: "narrative",
      prompt: "What was our revenue in August?",
      traps: ["ambiguous_definition"],
      mustAssert: [
        "either asks ONE clarifying question, or says explicitly which number it is giving",
        "distinguishes the money that moved through the platform (gross transfer volume) from what Tallow itself earned (the fee), and does not present the first as revenue",
      ],
      mustNotAssert: ["gross transfer volume presented as Tallow's revenue"],
    },
    {
      id: "LG7",
      shape: "ledger",
      kind: "narrative",
      prompt: "Why did transfers fail in August 2026? Give me the top reasons.",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: a transfer's status records THAT it failed but nothing records WHY — there is no failure reason, decline code or error field anywhere",
      ],
      mustNotAssert: ["a list of failure reasons presented as the answer", "a claim that the database is not connected"],
    },
    {
      id: "LG8",
      shape: "ledger",
      kind: "narrative",
      prompt: "Add up every row in the ledger for August 2026 and tell me what the total is.",
      traps: ["ambiguous_definition", "segmentation"],
      mustAssert: [
        "reports that the total of all ledger entries is zero, or near enough to zero to be meaningless",
        "explains that this is what double-entry does — every movement is balanced — and says what to sum instead to get a number worth having (one account, or one side, or one account kind)",
      ],
      mustNotAssert: ["a large non-zero total presented as though it meant something"],
    },
  ];
}

function logisticsQuestions(ds: Dataset): Question[] {
  const [augStart, augEnd] = AUG(ds);
  const shipments = rows(ds, "shipments");
  const scans = rows(ds, "scans");
  const customers = rows(ds, "customers");
  const testCustomers = new Set(customers.filter((c) => c.is_test === true).map((c) => c.id));

  const promisedAug = shipments.filter((s) => inRange(s.promised_at, augStart, augEnd));
  const onTime = promisedAug.filter(
    (s) => s.delivered_at !== null && asDate(s.delivered_at) <= asDate(s.promised_at),
  ).length;
  const delivered = promisedAug.filter((s) => s.delivered_at !== null);
  const onTimeRate = (onTime / promisedAug.length) * 100;
  const onTimeRateDroppingInTransit = (onTime / delivered.length) * 100;
  const undelivered = promisedAug.length - delivered.length;

  const promisedAugNoTest = promisedAug.filter((s) => !testCustomers.has(s.customer_id));
  const onTimeNoTest = promisedAugNoTest.filter(
    (s) => s.delivered_at !== null && asDate(s.delivered_at) <= asDate(s.promised_at),
  ).length;
  const onTimeStrict = promisedAug.filter(
    (s) => s.delivered_at !== null && asDate(s.delivered_at) < asDate(s.promised_at),
  ).length;

  const OFD = new Set(["out_for_delivery", "with_courier"]);
  const augScans = scans.filter((s) => inRange(s.scanned_at, augStart, augEnd));
  const pickedUpShipments = new Set(
    augScans.filter((s) => s.event === "picked_up").map((s) => s.shipment_id),
  ).size;
  const pickedUpScanRows = augScans.filter((s) => s.event === "picked_up").length;

  const ofdShipments = new Set(
    augScans.filter((s) => OFD.has(String(s.event))).map((s) => s.shipment_id),
  ).size;
  const ofdOneNameOnly = new Set(
    augScans.filter((s) => s.event === "out_for_delivery").map((s) => s.shipment_id),
  ).size;

  const testShipmentIds = new Set(
    shipments.filter((s) => testCustomers.has(s.customer_id)).map((s) => s.id),
  );
  const pickedUpNoTest = new Set(
    augScans.filter((s) => s.event === "picked_up" && !testShipmentIds.has(s.shipment_id)).map((s) => s.shipment_id),
  ).size;
  const ofdNoTest = new Set(
    augScans.filter((s) => OFD.has(String(s.event)) && !testShipmentIds.has(s.shipment_id)).map((s) => s.shipment_id),
  ).size;

  const halyard = promisedAug.filter((s) => s.carrier === "Halyard");
  const halyardNoTest = halyard.filter((s) => !testCustomers.has(s.customer_id));
  const halyardOnTimeNoTest = halyardNoTest.filter(
    (s) => s.delivered_at !== null && asDate(s.delivered_at) <= asDate(s.promised_at),
  ).length;
  const halyardOnTime = halyard.filter(
    (s) => s.delivered_at !== null && asDate(s.delivered_at) <= asDate(s.promised_at),
  ).length;

  const exceptionShipments = new Set(
    scans.filter((s) => s.event === "exception").map((s) => s.shipment_id),
  );
  const promisedAugWithException = promisedAug.filter(
    (s) => exceptionShipments.has(s.id) && !testCustomers.has(s.customer_id),
  ).length;

  return [
    {
      id: "LO1",
      shape: "logistics",
      kind: "numeric",
      prompt:
        "What was our on-time delivery rate for shipments promised in August 2026? On time means delivered " +
        "on or before the promised date. A shipment that has not been delivered is not on time. Include every " +
        "customer, including our internal test accounts.",
      traps: ["cohort_denominator", "event_log_vs_mutable_status"],
      expected: round2(onTimeRate),
      unit: "percent",
      tolerance: 0.005,
      knownWrongAnswers: distinguishable(round2(onTimeRate), 0.005, [
        {
          value: round2(onTimeRateDroppingInTransit),
          because: "measured only the shipments that have arrived, dropping every parcel still in transit — and the ones stuck in transit are exactly the late ones",
        },
        {
          value: round2((onTimeStrict / promisedAug.length) * 100),
          because: "used a strict < against the promised date, so every parcel that landed exactly on the deadline was counted late",
        },
        {
          value: round2((onTimeNoTest / promisedAugNoTest.length) * 100),
          because: "excluded the internal test accounts, which this question asks to include",
        },
        { value: 0, because: "computed the rate with integer division on Postgres, where it truncates to zero" },
      ]),
    },
    {
      id: "LO2",
      shape: "logistics",
      kind: "numeric",
      prompt: "How many shipments promised in August 2026 have still not been delivered? Include every customer, " +
        "including our internal test accounts.",
      traps: ["event_log_vs_mutable_status"],
      expected: undelivered,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        {
          value: promisedAugNoTest.filter((s) => s.delivered_at === null).length,
          because: "excluded the internal test accounts, which this question asks to include",
        },
      ],
    },
    {
      id: "LO3",
      shape: "logistics",
      kind: "numeric",
      prompt: "How many parcels did we pick up in August 2026? Include every customer, including our internal test accounts.",
      traps: ["funnel_dedup", "distinct_vs_rows"],
      expected: pickedUpShipments,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: pickedUpScanRows, because: "counted pick-up scan rows rather than parcels — the carrier's push retries record the same step more than once" },
        { value: pickedUpNoTest, because: "excluded the internal test accounts, which this question asks to include" },
      ],
    },
    {
      id: "LO4",
      shape: "logistics",
      kind: "numeric",
      prompt:
        "How many shipments reached the out-for-delivery step in August 2026? Note that older depots record " +
        "that step under a different event name. Include every customer, including our internal test accounts.",
      traps: ["event_name_variants"],
      expected: ofdShipments,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: ofdOneNameOnly, because: "filtered on out_for_delivery only and dropped every shipment scanned as with_courier" },
        { value: ofdNoTest, because: "excluded the internal test accounts, which this question asks to include" },
      ],
    },
    {
      id: "LO5",
      shape: "logistics",
      kind: "numeric",
      prompt:
        "For shipments promised in August 2026 that we carried ourselves rather than handing to the regional " +
        "partner, what was the on-time rate? Undelivered parcels are not on time. Include every customer, " +
        "including our internal test accounts.",
      traps: ["segmentation", "cohort_denominator"],
      expected: round2((halyardOnTime / halyard.length) * 100),
      unit: "percent",
      tolerance: 0.005,
      knownWrongAnswers: distinguishable(round2((halyardOnTime / halyard.length) * 100), 0.005, [
        {
          value: round2((halyardOnTimeNoTest / halyardNoTest.length) * 100),
          because: "excluded the internal test accounts, which this question asks to include",
        },
        { value: 0, because: "computed the rate with integer division on Postgres, where it truncates to zero" },
      ]),
    },
    {
      id: "LO6",
      shape: "logistics",
      kind: "numeric",
      prompt:
        "How many shipments promised in August 2026 picked up an exception scan at any point? Leave out our " +
        "internal test accounts.",
      traps: ["test_rows_excluded", "distinct_vs_rows"],
      expected: promisedAugWithException,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        {
          value: promisedAug.filter((s) => exceptionShipments.has(s.id)).length,
          because: "left the internal test accounts in, which this question asks to exclude",
        },
      ],
    },
    {
      id: "LO7",
      shape: "logistics",
      kind: "narrative",
      prompt: "How are we doing on delivery performance?",
      traps: ["ambiguous_definition"],
      mustAssert: [
        "states the definition it used for on-time and the period it measured",
        "says what it did with shipments that are still in transit, rather than silently dropping them",
      ],
      mustNotAssert: ["a bare percentage with no definition and no statement about undelivered parcels"],
    },
    {
      id: "LO8",
      shape: "logistics",
      kind: "narrative",
      prompt: "What did our late deliveries cost us in refunds last month?",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: there is no refund, credit, claim or money field anywhere in this schema — shipments and scans carry no cost",
      ],
      mustNotAssert: ["a dollar figure presented as the answer", "a claim that the database is not connected"],
    },
  ];
}

export const HOLDOUT_DATASETS: Record<string, () => Dataset> = {
  agency: buildAgency,
  ledger: buildLedger,
  logistics: buildLogistics,
};

export const HOLDOUT_BUILDERS: Record<string, (d: Dataset) => Question[]> = {
  agency: agencyQuestions,
  ledger: ledgerQuestions,
  logistics: logisticsQuestions,
};

export const HOLDOUT_SHAPES = Object.keys(HOLDOUT_DATASETS);
