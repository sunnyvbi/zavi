

export const EMAIL_SEND_EXEC_CLASSES: readonly string[] = ["email_campaign.create_and_send"];

export const AUTOPILOT_MAX_RECIPIENTS = 1000;
export const AUTOPILOT_SEND_SPACING_DAYS = 7;

export const EMAIL_SEND_CHANNEL = "email_marketing";

export function isEmailSendClass(execClass: string | null | undefined): boolean {
  return typeof execClass === "string" && EMAIL_SEND_EXEC_CLASSES.includes(execClass);
}

export function emailAudienceKey(payload: unknown): string | null {
  const p = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  const tool = typeof p.tool === "string" ? p.tool.trim() : "";
  const audience = typeof p.audience_id === "string" ? p.audience_id.trim() : "";
  return tool && audience ? `${tool}:${audience}` : null;
}

export type UnattendedEmailFacts = {
  autopilot_on: boolean | null;
  channel_autorun_on: boolean | null;
  audience_count: number | null;
  cgo_sent_to_audience_within_7d: boolean | null;
};

export type UnattendedEmailVerdict = { verdict: "allow" | "ask_founder"; reasons: string[] };

export function evaluateUnattendedEmail(f: UnattendedEmailFacts): UnattendedEmailVerdict {
  const reasons: string[] = [];
  if (f.autopilot_on === null) reasons.push("autopilot_unreadable");
  else if (!f.autopilot_on) reasons.push("autopilot_off");
  if (f.channel_autorun_on === null) reasons.push("channel_autorun_unreadable");
  else if (!f.channel_autorun_on) reasons.push("channel_autorun_off");
  if (f.audience_count === null || !Number.isFinite(f.audience_count)) reasons.push("audience_count_unreadable");
  else if (f.audience_count > AUTOPILOT_MAX_RECIPIENTS) reasons.push("audience_over_limit");
  if (f.cgo_sent_to_audience_within_7d === null) reasons.push("send_history_unreadable");
  else if (f.cgo_sent_to_audience_within_7d) reasons.push("sent_to_list_recently");
  return reasons.length ? { verdict: "ask_founder", reasons } : { verdict: "allow", reasons: [] };
}

const REASON_WORDS: Readonly<Record<string, string>> = {
  autopilot_off: "Autopilot is off",
  channel_autorun_off: "Email campaigns is not set to run on its own",
  audience_over_limit: `it would go to more than ${AUTOPILOT_MAX_RECIPIENTS.toLocaleString("en-US")} people`,
  sent_to_list_recently: `this list already got an email in the last ${AUTOPILOT_SEND_SPACING_DAYS} days`,
};

export function heldEmailAsk(reasons: readonly string[]): string {
  const known = reasons.map((r) => REASON_WORDS[r]).filter(Boolean);
  const why = known.length ? known.join("; ") : "Zavi could not check its limits for this send";
  return `Autopilot did not send this on its own: ${why}. Nothing was sent. Send it yourself if you agree.`;
}

export async function loadCgoEmailSendRecently(
  tenant_id: string,
  audienceKey: string,
  selfActionId: string,
  _now: Date = new Date(),
): Promise<boolean> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenant_id), "email_list_sent_recently", {
    p_key: audienceKey,
    p_except_rail: "channel_actions",
    p_except_id: selfActionId,
  });
  if (error) throw new Error("email_list_sent_recently failed");
  return data !== null && data !== undefined;
}

export type UnattendedEmailAction = {
  action_id: string;
  exec_class: string;
  payload: unknown;
  audience_count: number | null;
};

export type UnattendedEmailDeps = {
  autopilotOn: (tenant_id: string) => Promise<boolean>;
  channelAutorunOn: (tenant_id: string) => Promise<boolean>;
  sentRecently: typeof loadCgoEmailSendRecently;
  now: () => Date;
};

const DEFAULT_DEPS: UnattendedEmailDeps = {
  autopilotOn: async (tenant_id) => {
    const { getBoolSettingStrictResolved } = await import("@/services/settings");
    return getBoolSettingStrictResolved("cgo_autopilot_enabled", tenant_id);
  },
  channelAutorunOn: async (tenant_id) => {
    const { readChannelAutorun } = await import("./unattended-policy");
    return readChannelAutorun(tenant_id, EMAIL_SEND_CHANNEL);
  },
  sentRecently: loadCgoEmailSendRecently,
  now: () => new Date(),
};

async function fact<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    console.warn(`[unattended-email] fact unreadable: ${(e as Error).message}`);
    return null;
  }
}

export async function loadUnattendedEmailFacts(
  tenant_id: string,
  action: UnattendedEmailAction,
  deps: Partial<UnattendedEmailDeps> = {},
): Promise<UnattendedEmailFacts> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const key = isEmailSendClass(action.exec_class) ? emailAudienceKey(action.payload) : null;
  return {
    autopilot_on: await fact(() => d.autopilotOn(tenant_id)),
    channel_autorun_on: await fact(() => d.channelAutorunOn(tenant_id)),
    audience_count: action.audience_count,
    cgo_sent_to_audience_within_7d: key ? await fact(() => d.sentRecently(tenant_id, key, action.action_id, d.now())) : null,
  };
}

export async function authorizeUnattendedEmail(
  tenant_id: string,
  action: UnattendedEmailAction,
  opts: { where: "door" | "executor" | "deadline"; deps?: Partial<UnattendedEmailDeps> },
): Promise<UnattendedEmailVerdict> {
  let v: UnattendedEmailVerdict;
  try {
    v = evaluateUnattendedEmail(await loadUnattendedEmailFacts(tenant_id, action, opts.deps));
  } catch (e) {
    console.warn(`[unattended-email] send for ${tenant_id} left for the founder: ${(e as Error).message}`);
    v = { verdict: "ask_founder", reasons: ["gate_error"] };
  }
  if (v.verdict !== "allow") {
    try {
      const { logEvent } = await import("@/services/logging/logEvent");
      await logEvent({
        level: "info",
        source: "unattended-email",
        code: "cgo.unattended_email_ask_founder",
        message: `unattended email send held at ${opts.where}`,
        tenant_id,
        meta: { hold_reasons: v.reasons.slice(0, 5).join(",") },
      });
    } catch {
    }
  }
  return v;
}

export async function authorizeUnattendedListSend(
  tenant_id: string,
  audience_count: number | null,
  deps: Partial<UnattendedEmailDeps> = {},
): Promise<UnattendedEmailVerdict> {
  const d = { ...DEFAULT_DEPS, ...deps };
  let v: UnattendedEmailVerdict;
  try {
    v = evaluateUnattendedEmail({
      autopilot_on: await fact(() => d.autopilotOn(tenant_id)),
      channel_autorun_on: await fact(() => d.channelAutorunOn(tenant_id)),
      audience_count,
      cgo_sent_to_audience_within_7d: false,
    });
  } catch {
    v = { verdict: "ask_founder", reasons: ["gate_error"] };
  }
  return v;
}
