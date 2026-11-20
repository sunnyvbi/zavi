
export type OfferSide = "tenant" | "creator";

export type PlaceHoldForOfferInput = {
  tenant_id: string;
  offer_id: string;
  human_member_id: string;
  thread_id: string | null;
  proposed_by: OfferSide;
  accepted_by: OfferSide;

  kind: "ugc_video";
  package_snapshot: Record<string, unknown>;
  delivery_days: number;
  currency: "usd";

  price_cents: number;
  business_fee_cents: number;
  creator_fee_cents: number;

  idempotency_key: string;
  initiator?: "agent";
  agent_run_id?: string | null;
};

export type PlaceHoldForOfferResult = {
  order_id: string;
  status: string;
  already_existed: boolean;
  checkout_url?: string | null;
};

export type CreatorMoneyPort = {
  placeHoldForOffer(input: PlaceHoldForOfferInput): Promise<PlaceHoldForOfferResult>;
};

let registered: CreatorMoneyPort | null = null;

export function registerCreatorMoneyPort(port: CreatorMoneyPort): void {
  registered = port;
}

export function resolveCreatorMoneyPort(): CreatorMoneyPort {
  if (!registered) {
    throw new Error(
      "creator money port is not registered: slice S2/S3 must call registerCreatorMoneyPort() before an offer can be accepted.",
    );
  }
  return registered;
}

export function __setCreatorMoneyPortForTest(port: CreatorMoneyPort | null): void {
  registered = port;
}
