
import { emailSend } from "@/services/tools/email/_client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

export type FundraisingSendMode = "off" | "test" | "live";

export type SendFundraisingEmailParams = {
  tenant_id: string;
  to: string;
  subject: string;
  body: string;
  sender?: string;
  test_recipient?: string;
  decision_id?: string;
  run_id?: string;
  investor_id?: string;
  authorized_by?: string;
  authorized_at?: string;
};

export type SendFundraisingEmailResult =
  | { ok: true; message_id: string; provider: string; actual_recipient: string; audit_failed?: true }
  | { ok: false; error: string; provider: string; status?: "not_connected" | "blocked" };

async function loadSendConfig(
  tenant_id: string,
): Promise<{ send_mode: FundraisingSendMode; updated_by: string | null }> {
  const { data, error } = await serviceClient()
    .from("fundraising_round_config")
    .select("send_mode, updated_by")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error || !data) {
    return { send_mode: "off", updated_by: null };
  }
  const row = data as { send_mode?: unknown; updated_by?: unknown };
  const mode =
    row.send_mode === "test" || row.send_mode === "live" ? row.send_mode : "off";
  const updatedBy =
    typeof row.updated_by === "string" && row.updated_by.length > 0
      ? row.updated_by
      : null;
  return { send_mode: mode, updated_by: updatedBy };
}

async function resolveTestRecipient(
  updated_by: string | null,
): Promise<string | null> {
  if (!updated_by) return null;
  try {
    const { data, error } = await serviceClient().auth.admin.getUserById(
      updated_by,
    );
    if (error) return null;
    const email = data?.user?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

async function sendViaPipedreamGmail(
  _params: SendFundraisingEmailParams & { actual_to: string },
): Promise<{ message_id: string }> {
  throw new Error("not_implemented: Pipedream Gmail send not yet wired — connect Gmail in Pipedream first");
}

async function writeAuditRow(
  params: SendFundraisingEmailParams & {
    actual_recipient: string;
    status: "sent" | "failed" | "blocked" | "not_connected" | "test_sent";
    provider: string;
    provider_message_id?: string;
    safety_result?: Record<string, unknown>;
    error_detail?: string;
  },
): Promise<boolean> {
  try {
    const { error } = await serviceClient()
      .from("fundraising_send_audit")
      .insert({
        decision_id: params.decision_id ?? null,
        run_id: params.run_id ?? null,
        tenant_id: params.tenant_id,
        investor_id: params.investor_id ?? null,
        sender: params.sender ?? null,
        recipient: params.actual_recipient,
        subject: params.subject,
        status: params.status,
        provider: params.provider,
        provider_message_id: params.provider_message_id ?? null,
        safety_result: params.safety_result ?? null,
        authorized_by: params.authorized_by ?? null,
        authorized_at: params.authorized_at ?? null,
      });
    if (error) {
      console.error(
        `[fundraising/send-provider] AUDIT WRITE FAILED — integrity violation: ${error.message}`,
      );
      void logEvent({
        level: "error",
        source: "fundraising.send-provider",
        code: "fundraising_audit_write_failed",
        meta: { tenant_id: params.tenant_id, run_id: params.run_id ?? null },
      });
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[fundraising/send-provider] AUDIT WRITE THREW — integrity violation: ${(e as Error).message}`,
    );
    void logEvent({
      level: "error",
      source: "fundraising.send-provider",
      code: "fundraising_audit_write_failed",
      meta: { tenant_id: params.tenant_id, run_id: params.run_id ?? null },
    });
    return false;
  }
}

export async function sendFundraisingEmail(
  params: SendFundraisingEmailParams,
): Promise<SendFundraisingEmailResult> {
  const provider = "sendgrid";

  const { send_mode, updated_by } = await loadSendConfig(params.tenant_id);

  if (send_mode === "off") {
    await writeAuditRow({
      ...params,
      actual_recipient: params.to,
      provider,
      status: "blocked",
      safety_result: { reason: "send_mode_off" },
    });
    void logEvent({
      level: "info",
      source: "fundraising.send-provider",
      code: "fundraising_send_mode_off",
      meta: {
        tenant_id: params.tenant_id,
        run_id: params.run_id ?? null,
        investor_id: params.investor_id ?? null,
      },
    });
    return {
      ok: false,
      error: "send_mode is off — set send_mode to test or live to enable",
      provider,
      status: "blocked",
    };
  }

  const isTestMode = send_mode === "test";

  let actual_to: string;
  if (isTestMode) {
    const founderEmail = await resolveTestRecipient(updated_by);
    if (!founderEmail) {
      await writeAuditRow({
        ...params,
        actual_recipient: params.to,
        provider,
        status: "blocked",
        safety_result: { reason: "no_test_recipient" },
      });
      void logEvent({
        level: "warn",
        source: "fundraising.send-provider",
        code: "fundraising_no_test_recipient",
        meta: {
          tenant_id: params.tenant_id,
          run_id: params.run_id ?? null,
          investor_id: params.investor_id ?? null,
        },
      });
      return {
        ok: false,
        error: "test send: no founder email resolvable for the test recipient",
        provider,
        status: "blocked",
      };
    }
    actual_to = founderEmail;
  } else {
    actual_to = params.to;
  }

  const auditBase = { ...params, actual_recipient: actual_to, provider };

  try {
    void sendViaPipedreamGmail;

    const result = await emailSend(params.tenant_id, {
      to: actual_to,
      subject: params.subject,
      body_text: params.body,
      ...(params.sender ? { from_override: params.sender } : {}),
    });

    const status = isTestMode ? ("test_sent" as const) : ("sent" as const);
    const auditOk = await writeAuditRow({
      ...auditBase,
      status,
      provider_message_id: result.messageId,
    });

    void logEvent({
      level: "info",
      source: "fundraising.send-provider",
      code: "fundraising_email_sent",
      meta: {
        tenant_id: params.tenant_id,
        run_id: params.run_id ?? null,
        investor_id: params.investor_id ?? null,
        send_mode,
        provider,
        count: 1,
        audit_failed: !auditOk || undefined,
      },
    });

    return {
      ok: true,
      message_id: result.messageId,
      provider,
      actual_recipient: actual_to,
      ...(!isTestMode && !auditOk ? { audit_failed: true as const } : {}),
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const isNotConnected =
      err.code === "email_not_connected" || err.code === "email_from_not_set";
    const errorDetail = err.code
      ? `${err.code}: ${err.message ?? "send failed"}`
      : (err.message ?? "send failed");

    await writeAuditRow({
      ...auditBase,
      status: isNotConnected ? "not_connected" : "failed",
      error_detail: errorDetail,
    });

    return {
      ok: false,
      error: errorDetail,
      provider,
      ...(isNotConnected ? { status: "not_connected" as const } : {}),
    };
  }
}
