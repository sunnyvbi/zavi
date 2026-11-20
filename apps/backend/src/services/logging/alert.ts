
import { logEvent, logEventConfirmed } from "./logEvent";
import { sanitizeErrorMessage } from "./sanitize";
import { globalClient } from "@/services/tenant-client";
import { sgSend } from "@/email/sendAuthEmail";

const ALERT_PREFIX = "[ALERT:praxis-alerts]";
const WEBHOOK_TIMEOUT_MS = 5_000;
const MAX_WIRE_MESSAGE = 1_500;

const EMAIL_DEDUP_TABLE = "alert_email_dedup";
const EMAIL_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 3 * 60 * 1000;

const memoryDedup = new Map<string, number>();
const MEMORY_DEDUP_MAX_KEYS = 500;
const MEMORY_DEDUP_WINDOW_MS = 60 * 60 * 1000;

function memoryDedupShouldSuppress(dedupeKey: string, nowMs: number): boolean {
  const last = memoryDedup.get(dedupeKey);
  if (last !== undefined && nowMs - last < MEMORY_DEDUP_WINDOW_MS) return true;

  if (memoryDedup.size >= MEMORY_DEDUP_MAX_KEYS) {
    for (const [k, t] of memoryDedup) {
      if (nowMs - t >= MEMORY_DEDUP_WINDOW_MS) memoryDedup.delete(k);
    }
    if (memoryDedup.size >= MEMORY_DEDUP_MAX_KEYS) {
      const oldest = [...memoryDedup.entries()].sort(
        (a, b) => a[1] - b[1],
      )[0]?.[0];
      if (oldest) memoryDedup.delete(oldest);
    }
  }
  memoryDedup.set(dedupeKey, nowMs);
  return false;
}

export function __resetMemoryDedupForTests(): void {
  memoryDedup.clear();
}

export type AlertInput = {
  msg: string;
  source: string;
  code?: string;
  tenant_id?: string | null;
  email?: {
    dedupeKey: string;
    detail?: string;
    subjectDetail?: string;
    required?: boolean;
  };
};

const MAX_EMAIL_DETAIL = 8_000;

function opsRecipient(): string {
  return process.env.OPS_ALERT_EMAIL ?? "ravi@zaviagent.com";
}

async function maybeEmail(
  dedupeKey: string,
  subject: string,
  body: string,
  required = false,
): Promise<void> {
  const nowMs = Date.now();
  const sb = globalClient();

  const nowISO = new Date(nowMs).toISOString();
  const { data: claimed, error: claimErr } = await sb
    .from(EMAIL_DEDUP_TABLE)
    .upsert(
      { dedupe_key: dedupeKey, sent_at: nowISO, confirmed_at: null },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    )
    .select("dedupe_key");

  if (!claimErr) {
    const won = Array.isArray(claimed) && claimed.length > 0;
    if (!won) {
      const { data: existing } = await sb
        .from(EMAIL_DEDUP_TABLE)
        .select("confirmed_at, sent_at")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();

      const row = existing as {
        confirmed_at?: string | null;
        sent_at?: string | null;
      } | null;
      if (row?.confirmed_at) return;
      const claimedMs = row?.sent_at ? Date.parse(row.sent_at) : NaN;
      const abandoned =
        Number.isFinite(claimedMs) && nowMs - claimedMs > CLAIM_LEASE_MS;
      if (!abandoned) {
        if (required) throw new Error(`alert email ${dedupeKey} is in flight elsewhere`);
        return;
      }

      await sb
        .from(EMAIL_DEDUP_TABLE)
        .update({ sent_at: nowISO })
        .eq("dedupe_key", dedupeKey);
    }
  } else if (memoryDedupShouldSuppress(dedupeKey, nowMs)) {
    return;
  }

  const html = `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>`;

  try {
    await sgSend(opsRecipient(), subject, html, body);
  } catch (e) {
    try {
      await sb.from(EMAIL_DEDUP_TABLE).delete().eq("dedupe_key", dedupeKey);
    } catch {
    }
    memoryDedup.delete(dedupeKey);
    throw e;
  }

  try {
    await sb
      .from(EMAIL_DEDUP_TABLE)
      .update({ confirmed_at: new Date().toISOString() })
      .eq("dedupe_key", dedupeKey);
  } catch {
  }

  try {
    await sb
      .from(EMAIL_DEDUP_TABLE)
      .delete()
      .lt("sent_at", new Date(nowMs - EMAIL_DEDUP_TTL_MS).toISOString());
  } catch {
  }
}

function webhookUrl(): string | null {
  const raw = process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function postToSlack(url: string, text: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(
      `${ALERT_PREFIX} webhook POST returned ${res.status} (alert still logged to praxis_logs)`,
    );
  }
}

export async function alert(input: AlertInput): Promise<void> {
  const safeMsg = sanitizeErrorMessage(input.msg).slice(0, MAX_WIRE_MESSAGE);
  const source = input.source || "unknown";

  console.error(`${ALERT_PREFIX} ${source}: ${safeMsg}`);

  const durable = logEvent({
    level: "error",
    source: source.slice(0, 64),
    code: input.code,
    message: safeMsg,
    tenant_id: input.tenant_id ?? null,
  });

  const url = webhookUrl();
  if (url) {
    try {
      await postToSlack(url, `${ALERT_PREFIX} ${source}: ${safeMsg}`);
    } catch (e) {
      try {
        console.warn(
          `${ALERT_PREFIX} webhook POST failed: ${(e as Error).message}`,
        );
      } catch {
      }
    }
  }

  if (!input.email?.dedupeKey) {
    await durable;
    return;
  }
  try {
    await sendOpsAlertEmail({ ...input, email: input.email }, safeMsg, source);
  } catch (e) {
    try {
      console.warn(
        `${ALERT_PREFIX} email page failed: ${(e as Error).message}`,
      );
    } catch {
    }
    if (input.email.required) throw e;
  }
  await durable;
}

async function sendOpsAlertEmail(
  input: AlertInput & { email: NonNullable<AlertInput["email"]> },
  safeMsg: string,
  source: string,
): Promise<void> {
  const detail = (input.email.detail ?? "").slice(0, MAX_EMAIL_DETAIL);
  const truncated = (input.email.detail?.length ?? 0) > MAX_EMAIL_DETAIL;
  const subjectDetail = (input.email.subjectDetail ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  await maybeEmail(
    input.email.dedupeKey,
    `[Zavi ALERT] ${source}${input.tenant_id ? ` · tenant ${input.tenant_id}` : ""}${
      subjectDetail ? ` · ${subjectDetail}` : ""
    }`,
    `${safeMsg}\n${detail ? `\n${detail}${truncated ? "\n… (truncated)" : ""}\n` : ""}\nsource: ${source}\ncode: ${
      input.code ?? "-"
    }\ntenant: ${input.tenant_id ?? "global"}\nat: ${new Date().toISOString()}`,
    input.email.required === true,
  );
}

export async function emailOpsAlert(input: AlertInput & { email: NonNullable<AlertInput["email"]> }): Promise<boolean> {
  try {
    const safeMsg = sanitizeErrorMessage(input.msg).slice(0, MAX_WIRE_MESSAGE);
    await sendOpsAlertEmail(input, safeMsg, input.source || "unknown");
    return true;
  } catch (e) {
    try {
      console.warn(`${ALERT_PREFIX} email page failed: ${(e as Error).message}`);
    } catch {
    }
    return false;
  }
}

export async function deliverOpsAlert(
  input: Pick<AlertInput, "msg" | "source" | "code" | "tenant_id">,
  opts: { log?: boolean; writeLog?: typeof logEventConfirmed } = {},
): Promise<{ ok: boolean; error?: string }> {
  const safeMsg = sanitizeErrorMessage(input.msg).slice(0, MAX_WIRE_MESSAGE);
  const source = input.source || "unknown";
  const row = { level: "error" as const, source: source.slice(0, 64), code: input.code, message: safeMsg, tenant_id: input.tenant_id ?? null };
  const url = webhookUrl();
  if (!url) {
    const logged = await (opts.writeLog ?? logEventConfirmed)(row);
    return logged.ok ? { ok: true, error: "no_webhook" } : { ok: false, error: `log_write_failed: ${logged.error ?? "unknown"}` };
  }
  if (opts.log !== false) await logEvent(row);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${ALERT_PREFIX} ${source}: ${safeMsg}` }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: `webhook ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
