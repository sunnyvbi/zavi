import { useEffect, useState } from "react";
import { campaignFetch } from "../managed-campaigns/api";
import type { LinkedInPostPage } from "./LinkedInPostPreview";

export type LinkedInPostRead = { preview: string | null; author?: string; page?: LinkedInPostPage; postUrl?: string; repostNote?: string };

export const POST_UNREADABLE = "LinkedIn did not share this post's text with Zavi, so it cannot be previewed here. LinkedIn checks the post when the campaign is created.";

type Response = { post_urn?: string; post_preview?: string | null; author?: string; page?: LinkedInPostPage; repost_note?: string };

export function toPostRead(r: Response): LinkedInPostRead {
  return { preview: r.post_preview ?? null, author: r.author, page: r.page, postUrl: r.post_urn && /^urn:li:(share|ugcPost):\d+$/.test(r.post_urn) ? `https://www.linkedin.com/feed/update/${r.post_urn}/` : undefined, repostNote: r.repost_note || undefined };
}

export function readLinkedInPost(path: string): Promise<LinkedInPostRead> {
  return campaignFetch<Response>(path).then(toPostRead);
}

export function postAuthorName(read: LinkedInPostRead | undefined, accountName: string): string {
  return read?.author === "page" ? read.page?.name || accountName : read?.author === "member" ? "Thought Leader ad" : "";
}

const reads = new Map<string, Promise<LinkedInPostRead>>();

const notReadWords = (code: string | undefined) =>
  code === "forbidden" ? "Only a workspace owner or admin can see this post's text here."
    : code === "tenant_override_forbidden" ? "Switch to your own workspace to see this post's text here."
    : code === "channel_unavailable" || code === "coming_soon" ? "This post's text shows here once LinkedIn Ads is available on this workspace's plan."
    : code === "linkedin_ads_not_connected" || code === "linkedin_ads_token_revoked" ? "Reconnect LinkedIn Ads in Connectors to see this post's text here."
    : code === "linkedin_ads_post_unreadable" ? POST_UNREADABLE
    : "Zavi could not read this post just now, so its text is not shown here.";

export function useLinkedInPostRead(path: string) {
  const [state, setState] = useState<{ key: string; read: LinkedInPostRead | null; refused?: string } | null>(null);
  useEffect(() => {
    let live = true;
    const request = reads.get(path) ?? readLinkedInPost(path);
    reads.set(path, request);
    request.then(
      (read) => { if (live) setState({ key: path, read }); },
      (e: unknown) => { if (reads.get(path) === request) reads.delete(path); if (live) setState({ key: path, read: null, refused: notReadWords((e as { code?: string } | null)?.code) }); },
    );
    return () => { live = false; };
  }, [path]);
  const current = state?.key === path ? state : null;
  return { loading: !current, read: current?.read ?? null, refused: current?.refused };
}
