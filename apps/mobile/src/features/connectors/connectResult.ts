
export type ConnectResult =
  | { kind: "connected"; slug: string }
  | { kind: "failed"; slug: string | null; message: string }
  | { kind: "none" };

const SLACK_ERROR_COPY: Readonly<Record<string, string>> = {
  invalid_state: "Your Slack connection link expired. Tap Connect and try again.",
  state_consume_failed: "We couldn't verify your Slack connection. Please try connecting again.",
  missing_code: "Slack didn't finish the connection. Please try again.",
  missing_state: "Slack didn't finish the connection. Please try again.",
  save_failed: "We couldn't save your Slack connection. Please try again.",
  exchange_failed: "We couldn't reach Slack to finish connecting. Please try again in a moment.",
};

export function connectErrorCopy(code: string, name: string): string {
  switch (code) {
    case "invalid_state":
    case "pending_expired_or_consumed":
      return `The ${name} sign-in link expired. Tap Connect and try again.`;
    case "missing_params":
    case "missing_code":
    case "missing_state":
    case "permission_denied":
    case "missing_installation_id":
      return `${name} didn't finish connecting. If you cancelled, tap Connect to try again.`;
    case "state_session_mismatch":
      return `This ${name} sign-in was started from another account or workspace, so nothing was connected. Tap Connect to start your own.`;
    case "connector_misconfigured":
      return `${name} isn't available yet. Email support@zaviagent.com if you need it turned on.`;
    case "reconnect_required":
      return `${name} needs you to approve access again. Tap Connect and allow every permission it asks for.`;
    default:
      if (/^no_(accessible_|ad_)/.test(code)) return `Your ${name} sign-in has no account Zavi can read. Try a different login.`;
      return `Couldn't connect ${name}. Try again.`;
  }
}

function slugOfParam(key: string): string {
  if (key.startsWith("composio_")) return `composio.${key.slice("composio_".length)}`;
  if (key.startsWith("pipedream_")) return `pipedream.${key.slice("pipedream_".length)}`;
  return key;
}

export function readConnectResult(q: URLSearchParams, labelFor: (slug: string) => string): ConnectResult {
  const slackError = q.get("slack_error");
  if (slackError !== null) {
    return {
      kind: "failed",
      slug: "slack",
      message: SLACK_ERROR_COPY[slackError] ?? "Slack connection failed. Please try again.",
    };
  }
  const composioError = q.get("composio_error");
  if (composioError !== null) {
    const slug = composioError && composioError !== "unknown" ? `composio.${composioError}` : null;
    const name = slug ? labelFor(slug) : "the app";
    const code = q.get("code") ?? "";
    return { kind: "failed", slug, message: code ? connectErrorCopy(code, name) : `Couldn't connect ${name}. Try again.` };
  }
  const connectError = q.get("connect_error");
  if (connectError !== null) {
    const provider = q.get("provider");
    const slug = provider ? slugOfParam(provider) : null;
    if (connectError === "connected_but_expiry_not_recorded" && slug) return { kind: "connected", slug };
    return { kind: "failed", slug, message: connectErrorCopy(connectError, slug ? labelFor(slug) : "the app") };
  }
  let connected: string | null = null;
  q.forEach((v, k) => {
    if (connected === null && v === "connected") connected = slugOfParam(k);
  });
  return connected ? { kind: "connected", slug: connected } : { kind: "none" };
}
