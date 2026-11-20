import { describe, it, expect } from "vitest";
import { labChannelSlug } from "../lab-channel-slug";

const lab = { variants_lab: true, draft_mode: true };

describe("labChannelSlug", () => {
  it("a lab draft replay of a channel_actions channel reads its channel from the payload", () => {
    expect(labChannelSlug(lab, { channel_slug: "meta_ads" })).toBe("meta_ads");
  });

  it("a real run never takes the payload's word, even with the same payload", () => {
    expect(labChannelSlug({}, { channel_slug: "meta_ads" })).toBeNull();
    expect(labChannelSlug({ variants_lab: true }, { channel_slug: "meta_ads" })).toBeNull();
    expect(labChannelSlug({ draft_mode: true }, { channel_slug: "meta_ads" })).toBeNull();
  });

  it("a malformed slug or a channel without the actions store gets no history", () => {
    expect(labChannelSlug(lab, { channel_slug: "meta_ads'; drop" })).toBeNull();
    expect(labChannelSlug(lab, { channel_slug: "not_a_channel" })).toBeNull();
    expect(labChannelSlug(lab, null)).toBeNull();
  });
});
