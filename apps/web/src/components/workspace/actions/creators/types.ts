
export type CreatorCardSocial = {
  platform: string;
  handle: string;
  url: string | null;
  followers: number | null;
  label: string;
};

export type CreatorCardPackage = {
  id: string;
  kind: "ugc_video";
  title: string;
  price_cents: number;
  business_total_cents: number;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
};

export type CreatorCardData = {
  human_member_id: string;
  slug: string | null;
  display_name: string;
  city: string | null;
  country_code: string | null;
  bio: string | null;
  lanes: string[];
  niches: string[];
  has_intro_video: boolean;
  photo_url?: string | null;
  illustration_url?: string | null;
  bookable: boolean;
  socials: CreatorCardSocial[];
  packages: CreatorCardPackage[];
  rating: { average: number | null; count: number };
  invited?: boolean;
  status_label?: string;
};

export type BusinessThreadSummary = {
  thread_id: string;
  human_member_id: string;
  display_name: string;
  last_message: { body: string; sender_kind: string; created_at: string } | null;
  last_message_at: string | null;
  unread_count?: number;
};

export type CreatorThreadMessageRow = {
  id: string;
  sender_kind: "tenant" | "creator" | "staff" | "system" | string;
  body: string;
  created_at: string;
};

export type OfferFees = {
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  creator_payout_cents: number;
};

export type CreatorOfferView = {
  id: string;
  human_member_id: string;
  thread_id: string | null;
  proposed_by: "tenant" | "creator";
  kind: string;
  terms: Record<string, unknown>;
  price_cents: number;
  delivery_days: number;
  note: string | null;
  status: "open" | "accepted" | "declined" | "expired" | "withdrawn";
  expires_at: string;
  responded_at: string | null;
  created_at: string;
  product_needed?: boolean;
  fees: OfferFees;
  expired: boolean;
  awaiting_payment?: boolean;
  awaiting_approval?: boolean;
  closed_unpaid?: boolean;
};
