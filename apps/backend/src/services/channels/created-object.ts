export type CreatedObject = {
  platform: "meta" | "google" | "chatgpt" | "reddit" | "x" | "tiktok";
  object_type: "campaign" | "ad_set" | "ad_group" | "ad";
  id: string;
  status: "PAUSED" | "ACTIVE" | "ENABLED" | "UNVERIFIED";
  activated_at?: string;
};
