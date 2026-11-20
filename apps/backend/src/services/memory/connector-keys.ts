
export type ConnectorKeyKind =
  | "slack_channel"
  | "stripe_customer"
  | "github_repo"
  | "email_thread";

const MAX_KEYS = 16;
const MAX_KEY_CHARS = 256;

export function connectorKey(kind: ConnectorKeyKind, objectId: string | null | undefined): string | null {
  if (typeof objectId !== "string") return null;
  const id = objectId.trim();
  if (id.length === 0) return null;
  const key = `${kind}:${id}`;
  return key.length > MAX_KEY_CHARS ? key.slice(0, MAX_KEY_CHARS) : key;
}

export function normalizeConnectorKeys(keys: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k !== "string") continue;
    const trimmed = k.trim().slice(0, MAX_KEY_CHARS);
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

export function toPrefilterArg(keys: string[] | null | undefined): string[] | null {
  if (!keys || keys.length === 0) return null;
  return keys;
}

export function connectorKeysFromRouting(routing: {
  slackChannelId?: string | null;
  emailThreadId?: string | null;
}): string[] {
  return normalizeConnectorKeys([
    connectorKey("slack_channel", routing.slackChannelId),
    connectorKey("email_thread", routing.emailThreadId),
  ]);
}
