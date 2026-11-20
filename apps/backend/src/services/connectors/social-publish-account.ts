
import { railFor } from "@zavi/shared";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import {
  LINKEDIN_SOCIAL_SLUG,
  NATIVE_SOCIAL_ACCOUNT_ID,
} from "@/services/connectors/linkedin-social/constants";
import { isLinkedInSocialConnected } from "@/services/connectors/linkedin-social/publish";
import { isXSocialConnected } from "@/services/connectors/x-social/publish";
import { isRedditSocialConnected } from "@/services/connectors/reddit-social/publish";
import { isInstagramSocialConnected } from "@/services/connectors/instagram-social/publish";
import { isTikTokPublishUsable } from "@/services/connectors/tiktok/api";
import { connectorScopes, connectorTokenExpiresAt } from "@/services/connectors/core/token";
import { X_SOCIAL_SLUG } from "@/services/connectors/x-social/constants";
import {
  resolveChannelAction,
  type SocialChannelAction,
} from "@/services/connectors/social-channels";

export type SocialPublishTransport = "native" | "pipedream" | "composio";

const COMPOSIO_TOOLKIT: Record<string, string> = {
  instagram_image: "instagram",
  instagram_video: "instagram",
  youtube_video: "youtube",
  pinterest_pin: "pinterest",
  reddit: "reddit",
  reddit_comment: "reddit",
};
const COMPOSIO_ONLY_NOT_CONNECTED: Record<string, string> = {
  pinterest_pin: "no connected Pinterest account — connect Pinterest in Settings first",
  youtube_video: "no connected YouTube channel — connect YouTube in Settings first",
};
const composioToolkitFor = (channel: string): string | null =>
  Object.prototype.hasOwnProperty.call(COMPOSIO_TOOLKIT, channel) ? COMPOSIO_TOOLKIT[channel] : null;

export type ResolvedSocialAccount = {
  transport: SocialPublishTransport;
  accountId: string;
  action: SocialChannelAction;
};

export async function isLinkedInSocialUsable(tenantId: string): Promise<boolean> {
  if (!(await isLinkedInSocialConnected(tenantId))) return false;
  const exp = await connectorTokenExpiresAt(tenantId, LINKEDIN_SOCIAL_SLUG);
  return exp === null || exp.getTime() > Date.now();
}

export async function isXSocialMediaUsable(tenantId: string): Promise<boolean> {
  if (!(await isXSocialConnected(tenantId))) return false;
  const scopes = await connectorScopes(tenantId, X_SOCIAL_SLUG);
  return scopes === null || scopes.includes("media.write");
}

const X_MEDIA_NOT_USABLE =
  "Reconnect X in Settings to allow image and video posts, then ask Zavi in chat to stage this post again.";

type NativeChannel = {
  usable: (tenantId: string) => Promise<boolean>;
  notConnected: string;
};

const REDDIT_NATIVE: NativeChannel = {
  usable: isRedditSocialConnected,
  notConnected: "no connected Reddit account — connect Reddit in Settings first",
};

const NATIVE_CHANNELS: Record<string, NativeChannel> = {
  linkedin: {
    usable: isLinkedInSocialUsable,
    notConnected: "no connected linkedin account — connect (or reconnect) LinkedIn in Settings first",
  },
  linkedin_image: {
    usable: isLinkedInSocialUsable,
    notConnected: "no connected linkedin account — connect (or reconnect) LinkedIn in Settings first",
  },
  linkedin_video: {
    usable: isLinkedInSocialUsable,
    notConnected: "no connected linkedin account — connect (or reconnect) LinkedIn in Settings first",
  },
  x: {
    usable: isXSocialConnected,
    notConnected: "no connected X account — connect X in Settings first",
  },
  x_image: { usable: isXSocialMediaUsable, notConnected: X_MEDIA_NOT_USABLE },
  x_video: { usable: isXSocialMediaUsable, notConnected: X_MEDIA_NOT_USABLE },
  reddit: REDDIT_NATIVE,
  reddit_comment: REDDIT_NATIVE,
  instagram_image: {
    usable: isInstagramSocialConnected,
    notConnected: "no connected Instagram account — connect Instagram in Settings first",
  },
  instagram_video: {
    usable: isInstagramSocialConnected,
    notConnected: "no connected Instagram account — connect Instagram in Settings first",
  },
  tiktok_video: {
    usable: isTikTokPublishUsable,
    notConnected: "no connected TikTok account — connect TikTok in Settings first",
  },
};

export function nativeChannelFor(channel: string): NativeChannel | null {
  return Object.prototype.hasOwnProperty.call(NATIVE_CHANNELS, channel)
    ? NATIVE_CHANNELS[channel]
    : null;
}

export async function resolveSocialPublishAccount(
  tenantId: string,
  channel: string,
): Promise<ResolvedSocialAccount> {
  const action = resolveChannelAction(channel);

  const toolkit = composioToolkitFor(channel);
  if (toolkit && railFor(toolkit) === "composio") {
    const owned = await resolveOwnedComposioAccount(tenantId, toolkit);
    if (owned) return { transport: "composio", accountId: owned.connected_account_id, action };
  }
  const native = nativeChannelFor(channel);
  if (native && (await native.usable(tenantId))) {
    return { transport: "native", accountId: NATIVE_SOCIAL_ACCOUNT_ID, action };
  }
  throw new Error(
    native?.notConnected ?? COMPOSIO_ONLY_NOT_CONNECTED[channel] ?? `no connected ${channel} account — connect one first`,
  );
}

export async function verifySocialAccountAtPublish(args: {
  tenantId: string;
  channel: string;
  accountId: string;
  pipedreamAppSlug: string;
  transport: SocialPublishTransport;
}): Promise<boolean | "reconnect_required" | OwnedComposioAccount> {
  if (args.transport === "composio") {
    const toolkit = composioToolkitFor(args.channel);
    const owned = toolkit ? await resolveOwnedComposioAccount(args.tenantId, toolkit) : null;
    return owned && owned.connected_account_id === args.accountId ? owned : false;
  }
  if (args.transport === "pipedream") return composioToolkitFor(args.channel) ? "reconnect_required" : false;
  if (args.transport === "native") {
    const native = nativeChannelFor(args.channel);
    if (!native || args.accountId !== NATIVE_SOCIAL_ACCOUNT_ID) return false;
    return native.usable(args.tenantId);
  }
  return false;
}
