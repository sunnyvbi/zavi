
import {
  assertSafeUrl,
  SsrfBlockedError,
} from "../onboarding/enrichment/url-guard";

export { SsrfBlockedError };

export type A2APeerConfig = {
  base_url: string;
  shared_secret: string;
};

export type A2ACard = {
  schema_version: string;
  id: string;
  name: string;
  description: string;
  version: string;
  capabilities: {
    tools: string[];
    decision_class: string | null;
    impact_classes: string[];
    manual_only: boolean;
    side_effects: boolean;
  };
  endpoints: { dispatch: string };
};

export type A2ADispatchResult = {
  run_id: string;
  status: "success" | "parse_failed" | "dispatch_error";
  parsed: unknown;
  output_text: string;
  cost_usd: number;
  cost_tokens: number;
  parse_error: string | null;
  error: string | null;
};

export async function fetchAgentCards(peer: A2APeerConfig): Promise<A2ACard[]> {
  const url = peer.base_url.replace(/\/$/, "") + "/api/a2a/agent-cards";
  await assertSafeUrl(url);
  const r = await fetch(url, { headers: { Authorization: `A2A ${peer.shared_secret}` } });
  if (!r.ok) {
    throw new Error(`A2A agent-cards ${r.status}: ${await r.text()}`);
  }
  const body = (await r.json()) as { cards: A2ACard[] };
  return body.cards;
}

export async function dispatchPeer(
  peer: A2APeerConfig,
  args: { tenant_id: string; agent_id: string; payload?: unknown; sync?: boolean },
): Promise<A2ADispatchResult> {
  const url = peer.base_url.replace(/\/$/, "") + "/api/a2a/dispatch";
  await assertSafeUrl(url);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `A2A ${peer.shared_secret}`,
    },
    body: JSON.stringify({
      tenant_id: args.tenant_id,
      agent_id: args.agent_id,
      payload: args.payload ?? null,
      sync: args.sync ?? true,
    }),
  });
  if (!r.ok) {
    throw new Error(`A2A dispatch ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as A2ADispatchResult;
}
