
import { alert } from "@/services/logging/alert";

export function isOutOfCredit(code: string | null | undefined): boolean {
  return typeof code === "string" && /^dataforseo_(http_402|(task_)?402\d\d)$/.test(code);
}

let alertedDay: string | null = null;

export function __resetOutOfCreditAlertForTests(): void {
  alertedDay = null;
}

export function reportIfOutOfCredit(code: string | null | undefined, dataSource: string, now: Date = new Date()): void {
  if (!isOutOfCredit(code)) return;
  const day = now.toISOString().slice(0, 10);
  if (alertedDay === day) return;
  alertedDay = day;
  void alert({
    source: "dataforseo",
    code: "dataforseo_out_of_credit",
    msg:
      `DataForSEO is out of credit (${code} from ${dataSource}). ` +
      `Growth-card "AI answers" and "Found on Google" checks, the GEO sweep and reddit Google rank are down until the account is topped up.`,
    email: { dedupeKey: `dataforseo_out_of_credit:${day}`, subjectDetail: "top up DataForSEO" },
  }).catch(() => {});
}
