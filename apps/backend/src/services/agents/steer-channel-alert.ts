

export interface SteerChannelAlertDeps {
  sgSend: (to: string, subject: string, html: string, text: string) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: () => any;
  now: () => string;
}

async function defaultDeps(): Promise<SteerChannelAlertDeps> {
  const [{ serviceClient }, { sgSend }] = await Promise.all([
    import("../supabase"),
    import("../../email/sendAuthEmail"),
  ]);
  return {
    sgSend,
    serviceClient,
    now: () => new Date().toISOString(),
  };
}

function hasAllDeps(
  d?: Partial<SteerChannelAlertDeps>,
): d is SteerChannelAlertDeps {
  return !!d?.sgSend && !!d?.serviceClient && !!d?.now;
}

function recipient(): string {
  return process.env.OPS_ALERT_EMAIL ?? "ravi@zaviagent.com";
}

export function steerAlertBucketKey(nowISO: string): string {
  const ms = Date.parse(nowISO);
  const sixHours = 6 * 60 * 60 * 1000;
  const bucket = Number.isFinite(ms) ? Math.floor(ms / sixHours) : 0;
  return `6h:${bucket}`;
}

export function renderSteerChannelEmail(args: {
  error: string;
  consecutive: number;
  run_id: string;
  agent_slug: string;
  tenant_id: string;
}): { subject: string; html: string; text: string } {
  const subject = `🚨 Zavi barge-in steer channel is FAILING — interactive runs degrading`;

  const text = [
    `The barge-in steer channel (drain_agent_run_steers) is failing.`,
    ``,
    `Every chat/slack run that hits this is now DEGRADING to no-barge-in: the run`,
    `still completes and the user still gets their answer, but mid-run steering is`,
    `dead, and any message sent mid-run is answered by the reroute as a fresh turn`,
    `instead of steering the live run.`,
    ``,
    `Failed after: ${args.consecutive} consecutive drain attempts`,
    `Tripped by:   agent=${args.agent_slug} run=${args.run_id} tenant=${args.tenant_id}`,
    `Raw error:    ${args.error}`,
    ``,
    `Most likely causes:`,
    `  - the drain_agent_run_steers RPC is missing / wrong signature / lost its grant`,
    `  - Supabase is refusing the call (RLS, service_role grant, connection)`,
    ``,
    `Check:`,
    `  select proname, pg_get_function_identity_arguments(oid) from pg_proc`,
    `   where proname like '%steer%';`,
    ``,
    `Kill switch (stops the degradation, restores plain runs):`,
    `  system_config.blob.agent_barge_in_enabled = false`,
    ``,
    `Where to look:`,
    `  - Inngest fn runs: https://app.inngest.com (production env, app "zavi")`,
    `  - EC2 logs: ssh ubuntu@54.241.199.146 (worker host, runs agent runs) then docker logs praxis-backend --tail 200`,
    ``,
    `(You'll get at most one of these per 6h window.)`,
  ].join("\n");

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111;line-height:1.5">
      <p><b>The barge-in steer channel (<code>drain_agent_run_steers</code>) is failing.</b></p>
      <p>Every chat/slack run that hits this is <b>degrading to no-barge-in</b>. Runs still
      complete and users still get answers, but mid-run steering is dead.</p>
      <p>
        <b>Failed after:</b> ${args.consecutive} consecutive drain attempts<br/>
        <b>Tripped by:</b> agent=<code>${esc(args.agent_slug)}</code>
        run=<code>${esc(args.run_id)}</code> tenant=<code>${esc(args.tenant_id)}</code><br/>
        <b>Raw error:</b> <code>${esc(args.error)}</code>
      </p>
      <p><b>Kill switch</b> (restores plain runs):
        <code>system_config.blob.agent_barge_in_enabled = false</code></p>
      <p style="color:#666">You'll get at most one of these per 6h window.</p>
    </div>`;

  return { subject, html, text };
}

export async function maybeSendSteerChannelAlert(
  args: {
    run_id: string;
    tenant_id: string;
    agent_slug: string;
    error: string;
    consecutive: number;
  },
  depsIn?: Partial<SteerChannelAlertDeps>,
): Promise<void> {
  try {
    const deps: SteerChannelAlertDeps = hasAllDeps(depsIn)
      ? depsIn
      : { ...(await defaultDeps()), ...depsIn };
    const sb = deps.serviceClient();
    const dedupKey = steerAlertBucketKey(deps.now());

    const { data, error } = (await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle()) as {
      data: { blob?: Record<string, unknown> } | null;
      error: unknown;
    };

    const blob = (!error && data?.blob ? data.blob : {}) as Record<string, unknown>;
    if (blob.steer_channel_alert_sent_for === dedupKey) return;

    const { subject, html, text } = renderSteerChannelEmail(args);
    await deps.sgSend(recipient(), subject, html, text);
    await sb
      .from("system_config")
      .update({ blob: { ...blob, steer_channel_alert_sent_for: dedupKey } })
      .eq("id", 1);
  } catch (e) {
    console.warn(
      `[steer-channel-alert] failed to send ops alert: ${(e as Error)?.message ?? String(e)}`,
    );
  }
}

export function reportSteerDrainFailure(args: {
  run_id: string;
  tenant_id: string;
  agent_slug: string;
  error: string;
  consecutive: number;
  degraded: boolean;
}): void {
  console.warn(
    `[steer-channel] drain failed (run=${args.run_id} consecutive=${args.consecutive} degraded=${args.degraded}): ${args.error}`,
  );
  void (async () => {
    const { logEvent } = await import("../logging/logEvent");
    await logEvent({
      level: args.degraded ? "error" : "warn",
      source: "agents.steer_channel",
      code: args.degraded ? "steer_drain_degraded" : "steer_drain_error",
      message: `steer drain failed (consecutive=${args.consecutive}): ${args.error}`.slice(
        0,
        500,
      ),
      tenant_id: args.tenant_id,
      run_id: args.run_id,
    });
  })().catch(() => {});

  if (args.degraded) {
    void maybeSendSteerChannelAlert({
      run_id: args.run_id,
      tenant_id: args.tenant_id,
      agent_slug: args.agent_slug,
      error: args.error,
      consecutive: args.consecutive,
    });
  }
}
