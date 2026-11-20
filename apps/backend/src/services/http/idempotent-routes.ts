
export type IdempotentRoute = {
  method: "post" | "put" | "patch" | "delete";
  path: string;
  staleMs?: number;
  auth?: "pre_resolved";
  router?: { file: string; path: string };
};

export const IDEMPOTENT_ROUTES: readonly IdempotentRoute[] = [
  { method: "post", path: "/api/workspace/autopilot/build-product" },
  { method: "post", path: "/api/channels/tiktok_ads/campaigns" },
  { method: "post", path: "/api/channels/tiktok_ads/campaign-edits" },
  { method: "post", path: "/api/channels/tiktok_ads/campaign-videos" },
  { method: "post", path: "/api/channels/meta_ads/campaigns/:campaignId/ad-sets" },
  { method: "post", path: "/api/channels/meta_ads/campaigns/:campaignId/ads" },
  { method: "post", path: "/api/channels/google_ads/campaigns/:campaignId/ad-groups" },
  { method: "post", path: "/api/channels/google_ads/campaigns/:campaignId/ads" },
  { method: "post", path: "/api/shopify/app-home/billing", auth: "pre_resolved" },
  { method: "post", path: "/api/workspace/autopilot/refine-product" },
  { method: "post", path: "/api/workspace/autopilot/refine-undo" },
  { method: "post", path: "/api/workspace/autopilot/restore-checkpoint" },
  { method: "post", path: "/api/workspace/autopilot/runs/:run_id/continue" },
  { method: "post", path: "/api/workspace/autopilot/sites/:site_id/publish" },
  { method: "post", path: "/api/workspace/autopilot/live-edit/publish" },
  { method: "post", path: "/api/workspace/website/chat" },
  { method: "post", path: "/api/channel-actions/:id/redo" },
  { method: "post", path: "/api/approvals/:decision_id/redo" },
  { method: "post", path: "/api/agents/:slug/chat" },
  { method: "post", path: "/api/agents/:slug/run" },
  { method: "post", path: "/api/playbooks/:slug/launch" },
  { method: "post", path: "/api/creators/library/:asset_id/meta-ad" },
  { method: "post", path: "/api/channels/generated_video/studio/messages" },
  { method: "post", path: "/api/channels/generated_video/studio/render" },
  { method: "post", path: "/api/channels/generated_video/studio/videos/:id/post" },
  { method: "post", path: "/api/channels/meta_ads/boost" },
  { method: "post", path: "/api/channels/tiktok_organic/drafts" },
  { method: "post", path: "/api/social/propose" },
  { method: "post", path: "/api/email-cards/paste" },
  { method: "post", path: "/api/humans/briefs/:briefId/repost" },
  { method: "post", path: "/api/workspace/ad-budget/:id/human-actions" },
  { method: "post", path: "/api/workspace/engineer/preview-session" },
  { method: "post", path: "/api/website/resolve-edit" },
  { method: "post", path: "/api/website/resolve-chat-edit" },
  { method: "post", path: "/api/website/site-design-edit", staleMs: 35 * 60 * 1000 },
  { method: "post", path: "/api/website/site-comments" },
  { method: "post", path: "/api/website/site-comments/:id/replies" },
  { method: "post", path: "/api/website/site-comments/:id/status" },
  { method: "post", path: "/api/website/app-invites" },
  { method: "post", path: "/api/workspace/export-github" },
  {
    method: "post",
    path: "/api/v1/members/invite",
    router: { file: "members/index.ts", path: "/invite" },
  },
];
