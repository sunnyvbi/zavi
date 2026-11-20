
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const LEDGER_ANCHOR = "2026-09-01T12:00:00.000Z";

export function buildLedger(): Dataset {
  const rand = new Rand(880311);
  const anchor = new Date(LEDGER_ANCHOR);

  const accounts: Record<string, unknown>[] = [];
  accounts.push({
    id: 1,
    owner_ref: "tallow-platform",
    kind: "platform",
    currency: "USD",
    opened_at: daysBefore(anchor, 900, 9),
    closed_at: null,
  });
  accounts.push({
    id: 2,
    owner_ref: "tallow-fees",
    kind: "fee",
    currency: "USD",
    opened_at: daysBefore(anchor, 900, 9),
    closed_at: null,
  });
  for (let i = 3; i <= 260; i++) {
    accounts.push({
      id: i,
      owner_ref: `cust_${i}`,
      kind: "customer",
      currency: "USD",
      opened_at: daysBefore(anchor, rand.int(30, 700), rand.int(8, 20)),
      closed_at: i % 47 === 0 ? daysBefore(anchor, rand.int(1, 90), 12) : null,
    });
  }
  const FEE_ACCOUNT = 2;

  const transfers: Record<string, unknown>[] = [];
  const entries: Record<string, unknown>[] = [];
  const fees: Record<string, unknown>[] = [];
  const disputes: Record<string, unknown>[] = [];
  let entryId = 1;
  let feeId = 1;
  let disputeId = 1;
  let transferId = 1;

  const post = (tid: number, accountId: number, cents: number, at: Date | null) => {
    entries.push({
      id: entryId++,
      transfer_id: tid,
      account_id: accountId,
      amount_cents: cents,
      posted_at: at,
    });
  };

  const reversalTargets: { id: number; at: Date; gross: number; from: number; to: number }[] = [];

  for (let i = 0; i < 1400; i++) {
    const createdAt = daysBefore(anchor, rand.int(0, 150), rand.int(0, 23), rand.int(0, 59));
    const from = rand.int(3, 260);
    let to = rand.int(3, 260);
    if (to === from) to = from === 260 ? 3 : from + 1;
    const gross = rand.int(2_500, 480_000);
    const feeCents = Math.round(gross * 0.029) + 30;

    const roll = rand.next();
    const status = roll < 0.08 ? "pending" : roll < 0.13 ? "failed" : "settled";
    const tid = transferId++;

    transfers.push({
      id: tid,
      created_at: createdAt,
      status,
      gross_cents: gross,
      reversal_of_id: null,
      description: `transfer ${tid}`,
    });

    if (status === "pending") continue;

    const postedAt = status === "settled" ? createdAt : null;
    post(tid, from, -gross, postedAt);
    post(tid, to, gross - feeCents, postedAt);
    post(tid, FEE_ACCOUNT, feeCents, postedAt);

    if (status !== "settled") continue;

    fees.push({ id: feeId++, transfer_id: tid, amount_cents: feeCents, posted_at: createdAt });

    if (rand.chance(0.05)) reversalTargets.push({ id: tid, at: createdAt, gross, from, to });

    if (rand.chance(0.03)) {
      const openedAt = new Date(createdAt.getTime() + rand.int(1, 20) * 86_400_000);
      if (openedAt <= anchor) {
        const resolvedAt = new Date(openedAt.getTime() + rand.int(3, 30) * 86_400_000);
        const settled = resolvedAt <= anchor;
        const outcome = settled ? (rand.chance(0.45) ? "lost" : "won") : "pending";
        disputes.push({
          id: disputeId++,
          transfer_id: tid,
          opened_at: openedAt,
          resolved_at: settled ? resolvedAt : null,
          outcome,
          amount_cents: gross,
        });
        if (outcome === "lost") {
          const rid = transferId++;
          transfers.push({
            id: rid,
            created_at: resolvedAt,
            status: "settled",
            gross_cents: gross,
            reversal_of_id: tid,
            description: `chargeback for ${tid}`,
          });
          post(rid, to, -(gross - feeCents), resolvedAt);
          post(rid, from, gross, resolvedAt);
          post(rid, FEE_ACCOUNT, -feeCents, resolvedAt);
        }
      }
    }
  }

  for (const r of reversalTargets) {
    const reversedAt = new Date(r.at.getTime() + rand.int(1, 9) * 86_400_000);
    if (reversedAt > anchor) continue;
    const feeCents = Math.round(r.gross * 0.029) + 30;
    const rid = transferId++;
    transfers.push({
      id: rid,
      created_at: reversedAt,
      status: "settled",
      gross_cents: r.gross,
      reversal_of_id: r.id,
      description: `reversal of ${r.id}`,
    });
    post(rid, r.to, -(r.gross - feeCents), reversedAt);
    post(rid, r.from, r.gross, reversedAt);
    post(rid, FEE_ACCOUNT, -feeCents, reversedAt);
  }

  return {
    shape: "ledger",
    business:
      "Tallow moves money between customer accounts and runs a double-entry ledger. Every settled transfer " +
      "writes several SIGNED rows to ledger_entries that sum to zero: the sender is debited the gross " +
      "amount, the recipient is credited the gross less Tallow's fee, and the fee account is credited the " +
      "fee. Tallow's own income is the fee. A transfer can be pending (nothing posted yet), failed " +
      "(entries exist but were never posted), or settled. A transfer can later be reversed — an operational " +
      "reversal or a lost dispute — which writes a second, mirrored set of entries rather than deleting the " +
      "first. Timestamps are stored in UTC and the team reports on a UTC calendar.",
    anchorIso: LEDGER_ANCHOR,
    timezone: "UTC",
    tables: [
      table(
        "accounts",
        [
          { name: "id", type: "pk" },
          { name: "owner_ref", type: "text" },
          { name: "kind", type: "text" },
          { name: "currency", type: "text" },
          { name: "opened_at", type: "timestamp" },
          { name: "closed_at", type: "timestamp", nullable: true },
        ],
        accounts,
      ),
      table(
        "transfers",
        [
          { name: "id", type: "pk" },
          { name: "created_at", type: "timestamp" },
          { name: "status", type: "text" },
          { name: "gross_cents", type: "bigint" },
          { name: "reversal_of_id", type: "int", nullable: true },
          { name: "description", type: "text" },
        ],
        transfers,
      ),
      table(
        "ledger_entries",
        [
          { name: "id", type: "pk" },
          { name: "transfer_id", type: "int" },
          { name: "account_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "posted_at", type: "timestamp", nullable: true },
        ],
        entries,
      ),
      table(
        "transfer_fees",
        [
          { name: "id", type: "pk" },
          { name: "transfer_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "posted_at", type: "timestamp" },
        ],
        fees,
      ),
      table(
        "disputes",
        [
          { name: "id", type: "pk" },
          { name: "transfer_id", type: "int" },
          { name: "opened_at", type: "timestamp" },
          { name: "resolved_at", type: "timestamp", nullable: true },
          { name: "outcome", type: "text" },
          { name: "amount_cents", type: "bigint" },
        ],
        disputes,
      ),
    ],
  };
}
