import { apiFetch } from "@/lib/api";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { showConnectorError } from "./connectorErrorDialog";
import { clearChannelReadCache } from "@/lib/workspace/channelReadCache";

const RAW_FAILURE_CODES = new Set(["rpc_failed", "rpc_missing"]);

export type ConnectorDisconnectSpec = {
  path: string;
  title: string;
  description: string;
  method?: "DELETE";
};

export const CONNECTOR_DISCONNECT: Record<string, ConnectorDisconnectSpec> = {
  x_social: {
    path: "x_social",
    title: "Disconnect X?",
    description:
      "Zavi stops posting to this account and deletes its stored tokens. You can reconnect anytime.",
  },
  reddit_social: {
    path: "reddit_social",
    title: "Disconnect Reddit?",
    description:
      "Zavi stops posting to this account and removes its connection. You can reconnect anytime.",
  },
  instagram_social: {
    path: "instagram_social",
    title: "Disconnect Instagram?",
    description:
      "Zavi stops posting to this account and removes its connection. You can reconnect anytime.",
  },
  meta_ads: {
    path: "meta-ads",
    title: "Disconnect Meta Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored token. You can reconnect anytime.",
  },
  x_ads: {
    path: "x_ads",
    title: "Disconnect X Ads?",
    description:
      "Zavi loses access to this ad account and deletes its stored tokens. Campaigns already running on X continue. You can reconnect anytime.",
  },
  linkedin_ads: {
    path: "linkedin_ads",
    title: "Disconnect LinkedIn Ads?",
    description:
      "Zavi stops reading the LinkedIn ad accounts you pay for yourself and deletes its stored tokens. Campaigns running on those accounts keep running and spending, and Zavi can no longer pause them, so pause them in LinkedIn Campaign Manager first if you want them stopped. Campaigns paid from your Zavi balance are not affected, and Zavi can still pause them. You can reconnect anytime.",
  },
  tiktok_ads: {
    path: "tiktok_ads",
    title: "Disconnect TikTok Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored tokens. You can reconnect anytime.",
  },
  reddit_ads: {
    path: "reddit_ads",
    title: "Disconnect Reddit Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored tokens. You can reconnect anytime.",
  },
  snapchat_ads: {
    path: "snapchat_ads",
    title: "Disconnect Snapchat Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored tokens. You can reconnect anytime.",
  },
  spotify_ads: {
    path: "spotify_ads",
    title: "Disconnect Spotify Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored tokens. You can reconnect anytime.",
  },
  pinterest_ads: {
    path: "pinterest_ads",
    title: "Disconnect Pinterest Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored tokens. You can reconnect anytime.",
  },
  microsoft_ads: {
    path: "microsoft_ads",
    title: "Disconnect Microsoft Ads?",
    description:
      "Zavi stops reading this ad account and deletes its stored tokens. You can reconnect anytime.",
  },
  higgsfield: {
    path: "higgsfield",
    title: "Disconnect Higgsfield?",
    description:
      "Zavi stops generating on this account and deletes its stored token. You can reconnect anytime.",
  },
  tiktok: {
    path: "tiktok",
    title: "Disconnect TikTok?",
    description:
      "Zavi stops posting to this account and deletes its stored tokens. You can reconnect anytime.",
  },
  discord: {
    path: "discord",
    title: "Disconnect Discord?",
    description: "Zavi stops answering in that server. The bot stays installed.",
  },
  telegram: {
    path: "telegram",
    title: "Disconnect Telegram?",
    description: "Zavi stops answering in every linked chat and group.",
  },
  email: {
    path: "email",
    method: "DELETE",
    title: "Disconnect SendGrid?",
    description:
      "Zavi deletes the stored key: one-to-one email and email campaigns through SendGrid stop. Approved cards that have not sent yet will not send. You can reconnect anytime.",
  },
  whatsapp: {
    path: "whatsapp",
    title: "Disconnect WhatsApp?",
    description: "Zavi stops answering every linked number.",
  },
  imessage: {
    path: "imessage",
    title: "Disconnect iMessage?",
    description: "Zavi stops answering every linked number.",
  },
};

export function canDisconnect(slug: string): boolean {
  return Boolean(CONNECTOR_DISCONNECT[slug]);
}

export async function disconnectConnector(
  slug: string,
  label: string,
  opts?: {
    sourceSlugs?: string[];
  },
): Promise<void> {
  const spec = CONNECTOR_DISCONNECT[slug];
  if (!spec) return;
  const sources = opts?.sourceSlugs?.length ? opts.sourceSlugs : [slug];
  const composioToolkits = sources
    .filter((s) => s.startsWith("composio."))
    .map((s) => s.slice("composio.".length));
  const hasNative = sources.some((s) => !s.startsWith("composio."));
  const confirmed = await confirmAction({
    title: spec.title,
    description: spec.description,
    confirmLabel: "Disconnect",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    let r: Response | null = null;
    let partlyDone = false;
    for (const toolkit of composioToolkits) {
      r = await apiFetch(`/api/connectors/composio/${toolkit}/disconnect`, { method: "POST" });
      if (!r.ok) break;
      partlyDone = true;
    }
    if ((r === null || r.ok) && hasNative) {
      r =
        spec.method === "DELETE"
          ? await apiFetch(`/api/connectors/${spec.path}`, { method: "DELETE" })
          : await apiFetch(`/api/connectors/${spec.path}/disconnect`, { method: "POST" });
    }
    if (r === null) return;
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      const code = body?.error?.code;
      showConnectorError({
        title: `Couldn’t disconnect ${label}`,
        message:
          code === "forbidden" || code === "not_admin"
            ? `Only a workspace owner or admin can disconnect ${label}. Ask one of them to do it.`
            : body?.error?.message && !(code && RAW_FAILURE_CODES.has(code))
              ? body.error.message
              : partlyDone
                ? `Zavi couldn’t finish disconnecting ${label}, so part of it may still be connected. Try again in a minute.`
                : `${label} is still connected: Zavi couldn’t disconnect it just now. Try again in a minute.`,
      });
      return;
    }
    clearChannelReadCache();
    window.location.reload();
  } catch (e) {
    showConnectorError({
      title: `Couldn’t disconnect ${label}`,
      message: (e as Error).message,
    });
  }
}
