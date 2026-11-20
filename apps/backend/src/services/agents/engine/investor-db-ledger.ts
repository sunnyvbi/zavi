

const FIRM_NOISE_TOKENS = new Set([
  "ventures",
  "venture",
  "capital",
  "vc",
  "partners",
  "partner",
  "fund",
  "funds",
  "management",
  "llc",
  "lp",
]);

export function canonicalFirm(firm: string): string {
  const cleaned = (firm ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(" ");
  while (tokens.length > 1 && FIRM_NOISE_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

export function normalizeName(name: string): string {
  return (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function investorKey(firm: string, name: string): string {
  return `${canonicalFirm(firm)}|${normalizeName(name)}`;
}

const ledgers = new Map<string, Set<string>>();

const MAX_RUNS_RETAINED = 200;

function ledgerFor(run_id: string): Set<string> {
  let s = ledgers.get(run_id);
  if (!s) {
    if (ledgers.size >= MAX_RUNS_RETAINED) {
      const oldest = ledgers.keys().next().value;
      if (oldest !== undefined) ledgers.delete(oldest);
    }
    s = new Set();
    ledgers.set(run_id, s);
  }
  return s;
}

type InvestorDbRow = {
  name?: string | null;
  primary_firm?: string | null;
  firm?: string | null;
};

export function recordInvestorDbResults(
  run_id: string,
  rows: readonly InvestorDbRow[] | undefined | null,
): void {
  if (!run_id || !Array.isArray(rows)) return;
  const set = ledgerFor(run_id);
  for (const r of rows) {
    const firm = r?.primary_firm ?? r?.firm ?? "";
    const name = r?.name ?? "";
    if (!firm && !name) continue;
    set.add(investorKey(firm, name));
  }
}

export function isFromInvestorDb(
  run_id: string,
  firm: string,
  name: string,
): boolean {
  if (!run_id) return false;
  return ledgers.get(run_id)?.has(investorKey(firm, name)) ?? false;
}

export function investorDbLedgerSize(run_id: string): number {
  return ledgers.get(run_id)?.size ?? 0;
}

export function clearInvestorDbLedger(run_id: string): void {
  ledgers.delete(run_id);
}

export function __resetInvestorDbLedgerForTest(): void {
  ledgers.clear();
}
