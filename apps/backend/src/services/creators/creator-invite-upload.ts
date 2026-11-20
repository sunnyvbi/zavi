
import {
  existingAccounts,
  parseCreatorSheet,
  pickFirstInvitable,
  upsertFromSheet,
  type SheetReport,
  type SheetRow,
  type UpsertResult,
} from "./creator-invites";

export const BATCH_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function validateBatch(batch: string | undefined): string {
  if (!batch || !BATCH_RE.test(batch)) {
    throw new Error("batch is required (letters, digits, - and _; e.g. sheet-2026-09 or dev-test).");
  }
  return batch;
}

export function validateLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("limit must be a positive whole number.");
  return n;
}

export type UploadPlan = {
  report: SheetReport;
  rowCount: number;
  withEmail: number;
  holds: Record<string, number>;
  inConversation: number;
  hasAccountRows: number[];
  invitableNow: number;
  invitableWithConversation: number;
  limit: number | null;
  loaded: SheetRow[];
  result: UpsertResult | null;
  missingEmailCsv: string;
};

export async function planUpload(opts: {
  csvText: string;
  batch: string;
  limit: number | null;
  apply: boolean;
  excludeDomains?: readonly string[];
  sheetOnly?: boolean;
}): Promise<UploadPlan> {
  const { rows, report } = parseCreatorSheet(opts.csvText, { excludeDomains: [...(opts.excludeDomains ?? [])] });

  const holds: Record<string, number> = {};
  for (const r of rows) if (r.holdReason) holds[r.holdReason] = (holds[r.holdReason] ?? 0) + 1;
  const withEmail = rows.filter((r) => r.email);
  const accounts = opts.sheetOnly ? new Map<string, string>() : await existingAccounts(withEmail.map((r) => r.email as string));
  const hasAccount = withEmail.filter((r) => accounts.has(r.email as string));
  const open = rows.filter((r) => r.email && !r.holdReason && !accounts.has(r.email));

  const loaded = opts.limit === null ? rows : pickFirstInvitable(rows, accounts, opts.limit);
  const result = opts.sheetOnly ? null : await upsertFromSheet(loaded, opts.batch, opts.apply);

  return {
    report,
    rowCount: rows.length,
    withEmail: withEmail.length,
    holds,
    inConversation: rows.filter((r) => r.inConversation).length,
    hasAccountRows: hasAccount.map((r) => r.sheetRow),
    invitableNow: open.filter((r) => !r.inConversation).length,
    invitableWithConversation: open.length,
    limit: opts.limit,
    loaded,
    result,
    missingEmailCsv: safeMissingEmailCsv(rows),
  };
}

function safeCell(v: string): string {
  const neutral = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(neutral) ? `"${neutral.replace(/"/g, '""')}"` : neutral;
}

export function safeMissingEmailCsv(rows: readonly SheetRow[]): string {
  const lines = rows
    .filter((r) => !r.email)
    .sort((a, b) => a.sheetRow - b.sheetRow)
    .map((r) => [String(r.sheetRow), safeCell(r.displayName), safeCell(r.holdReason ?? "")].join(","));
  return ["sheet_row,creator,hold_reason", ...lines].join("\n") + "\n";
}
