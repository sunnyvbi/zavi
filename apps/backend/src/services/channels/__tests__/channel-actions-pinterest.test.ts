import { describe, expect, it } from "vitest";
import { deriveActionType } from "../action-type";

const derive = (slug: string, title: string, kind: string | null) =>
  deriveActionType(slug, { title, deliverable: kind ? { kind } : null }).action_type;

describe("pinterest_organic action types", () => {
  it("a pin draft is an image post", () => {
    expect(derive("pinterest_organic", "Upload pin: Sage linen table runner for spring", "post")).toBe("image_post");
  });

  it("a site fix handed over as code is a fix, even with 'Pin' in the title", () => {
    expect(derive("pinterest_organic", "Add price tags so your Rich Pins show a price", "code")).toBe("fix");
  });

  it("the branch does not reach any other channel", () => {
    expect(derive("instagram_organic", "Post episode one", "post")).toBe("text_post");
    expect(derive("reddit_organic", "Post this", "post")).toBe("text_post");
  });
});
