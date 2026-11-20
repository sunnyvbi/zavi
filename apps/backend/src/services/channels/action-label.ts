
const LABEL: Record<string, string> = {
  text_post: "Post it",
  image_post: "Post it",
  video_post: "Post it",
  reply: "Reply",
  send_message: "Send it",
  create_ad: "Create ad",
  update_ad: "Apply change",
  pause_ad: "Pause",
  fix: "Fix it",
  check: "Do it",
  setup: "Set it up",
  page: "Open the page",
  other: "Do it",
};

const UNKNOWN = "Do it";

export type ActionLabelInput = {
  action_type: string;
  title: string;
  rows?: Array<{ item: string; before: string; after: string }> | null;
  exec_class?: string | null;
};

const REMOVAL_EXEC = /^(?:google_ads\.remove_resource|meta_ads\.delete_campaign|reddit_ads\.remove_object|tiktok_ads\.delete_campaign)(?:\.|$)/;

export const AD_LABELS: ReadonlySet<string> = new Set(["Create ad", "Apply change", "Pause", "Remove", "Adjust budget", "Change locations"]);

export function actionLabel(a: ActionLabelInput): string {
  if (a.exec_class && REMOVAL_EXEC.test(a.exec_class)) return "Remove";
  if (a.exec_class === "meta_ads.replace_ad_set_geo_review") return "Change locations";
  if (a.action_type === "pause_ad" && a.rows?.some((r) => /^removed for good$/i.test(r.after.trim()))) {
    return "Remove";
  }
  if (a.action_type === "update_ad" && a.rows?.some((r) => /(?:^|\s)budget$/i.test(r.item.trim()))) {
    return "Adjust budget";
  }
  return LABEL[a.action_type] ?? UNKNOWN;
}
