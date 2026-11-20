import { adReviewVersion } from "@/services/channels/ad-review/version";

export function socialDraftVersion(body: unknown): string {
  return adReviewVersion("social.publish.v2", body);
}
