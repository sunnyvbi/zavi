
import { serviceClient as defaultServiceClient } from "@/services/supabase";
import { sgSend as defaultSgSend } from "@/email/sendAuthEmail";

export interface ParsedUsageLimit {
  hit: boolean;
  resetsAt: string | null;
}

const HIT_PATTERNS: RegExp[] = [
  /hit your limit/i,
  /usage limit/i,
  /reached your limit/i,
  /\brate limit\b[\s\S]*\bresets?\b/i,
  /exceeded your[\s\S]*\blimit\b/i,
  /\bout of extra usage\b/i,
];

function extractResetsAt(message: string): string | null {
  const m = message.match(
    /resets?(?:\s+(?:at|on|in))?\s+([^.\n]+?(?:\([A-Z]{2,5}\))?)\s*\.?\s*$/i,
  );
  if (m && m[1]) {
    const v = m[1].trim();
    if (/\d|\([A-Z]{2,5}\)/.test(v)) return v;
  }
  return null;
}

export function parseUsageLimit(message: string): ParsedUsageLimit {
  const text = message ?? "";
  const hit = HIT_PATTERNS.some((re) => re.test(text));
  if (!hit) return { hit: false, resetsAt: null };
  return { hit: true, resetsAt: extractResetsAt(text) };
}

export interface UsageLimitAlertDeps {
  sgSend: (to: string, subject: string, html: string, text: string) => Promise<void>;
  serviceClient: () => ReturnType<typeof defaultServiceClient>;
  now: () => string;
}

function defaultDeps(): UsageLimitAlertDeps {
  return {
    sgSend: defaultSgSend,
    serviceClient: defaultServiceClient,
    now: () => new Date().toISOString(),
  };
}

function recipient(): string {
  return process.env.OPS_ALERT_EMAIL ?? "ravi@zaviagent.com";
}

function timeBucketKey(nowISO: string): string {
  const ms = Date.parse(nowISO);
  const sixHours = 6 * 60 * 60 * 1000;
  const bucket = Number.isFinite(ms) ? Math.floor(ms / sixHours) : 0;
  return `unparseable:6h:${bucket}`;
}

function renderEmail(args: {
  resetsAt: string | null;
  message: string;
  run_id: string;
  agent_slug: string;
  tenant_id: string;
}): { subject: string; html: string; text: string } {
  const resetLabel = args.resetsAt ?? "unknown";
  const subject = `🚨 Zavi agent fleet hit Claude usage limit — resets ${resetLabel}`;

  const text = [
    `The Zavi agent fleet is failing agent runs on a Claude account usage cap.`,
    ``,
    `Resets:     ${resetLabel}`,
    `Tripped by: agent=${args.agent_slug} run=${args.run_id} tenant=${args.tenant_id}`,
    `Raw error:  ${args.message}`,
    ``,
    `All agent runs will keep failing until the limit resets or the plan is raised.`,
    ``,
    `Where to look:`,
    `  - Inngest fn runs: https://app.inngest.com (production env, app "zavi")`,
    `  - EC2 logs: ssh ubuntu@54.241.199.146 (worker host, runs agent runs) then docker logs praxis-backend --tail 200`,
    ``,
    `(You'll get exactly one of these per reset window.)`,
  ].join("\n");

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111;line-height:1.5">
      <h2 style="margin:0 0 12px">🚨 Zavi agent fleet hit a Claude usage limit</h2>
      <p>The agent fleet is failing agent runs on a <strong>Claude account usage cap</strong>.
      All agent runs will keep failing until the limit resets or the plan is raised.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:2px 12px 2px 0;color:#666">Resets</td><td><strong>${esc(resetLabel)}</strong></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666">Tripped by</td><td>agent <code>${esc(args.agent_slug)}</code> · run <code>${esc(args.run_id)}</code> · tenant <code>${esc(args.tenant_id)}</code></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top">Raw error</td><td><code>${esc(args.message)}</code></td></tr>
      </table>
      <p style="color:#666">Where to look:</p>
      <ul style="color:#666;margin:0 0 12px">
        <li>Inngest fn runs: <a href="https://app.inngest.com">app.inngest.com</a> (prod env, app "zavi")</li>
        <li>EC2 logs: <code>ssh ubuntu@54.241.199.146</code> (worker host) then <code>docker logs praxis-backend --tail 200</code></li>
      </ul>
      <p style="color:#999;font-size:12px">You'll get exactly one of these per reset window.</p>
    </div>`.trim();

  return { subject, html, text };
}

export async function maybeSendUsageLimitAlert(args: {
  message: string;
  run_id: string;
  tenant_id: string;
  agent_slug: string;
  force?: boolean;
  deps?: Partial<UsageLimitAlertDeps>;
}): Promise<void> {
  const deps: UsageLimitAlertDeps = { ...defaultDeps(), ...(args.deps ?? {}) };
  try {
    const parsed = parseUsageLimit(args.message);
    if (!args.force && !parsed.hit) return;

    const nowISO = deps.now();
    const dedupKey = parsed.resetsAt ?? timeBucketKey(nowISO);

    const sb = deps.serviceClient();

    if (!args.force) {
      const { data, error } = await sb
        .from("system_config")
        .select("blob")
        .eq("id", 1)
        .maybeSingle();
      const blob = (!error && data?.blob ? data.blob : {}) as Record<string, unknown>;
      if (blob.usage_limit_alert_sent_for === dedupKey) {
        return;
      }

      const { subject, html, text } = renderEmail({
        resetsAt: parsed.resetsAt,
        message: args.message,
        run_id: args.run_id,
        agent_slug: args.agent_slug,
        tenant_id: args.tenant_id,
      });
      await deps.sgSend(recipient(), subject, html, text);

      const { error: markErr } = await sb.rpc("system_config_merge", {
        p_patch: { usage_limit_alert_sent_for: dedupKey, usage_limit_alert_sent_at: nowISO },
      });
      if (markErr) throw new Error(markErr.message);
      return;
    }

    const { subject, html, text } = renderEmail({
      resetsAt: parsed.resetsAt,
      message: args.message,
      run_id: args.run_id,
      agent_slug: args.agent_slug,
      tenant_id: args.tenant_id,
    });
    await deps.sgSend(recipient(), subject, html, text);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[usage-limit-alert] alert failed (run=${args.run_id}): ${(e as Error).message}`,
    );
  }
}

export async function sendUsageLimitAlertEmail(
  args?: Partial<{
    message: string;
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    deps: Partial<UsageLimitAlertDeps>;
  }>,
): Promise<void> {
  await maybeSendUsageLimitAlert({
    message:
      args?.message ??
      "[manual test-send] Claude Code returned an error result: You've hit your limit · resets Jun 13, 12am (UTC)",
    run_id: args?.run_id ?? "manual-test-send",
    tenant_id: args?.tenant_id ?? "ops",
    agent_slug: args?.agent_slug ?? "ops-test",
    force: true,
    deps: args?.deps,
  });
}
