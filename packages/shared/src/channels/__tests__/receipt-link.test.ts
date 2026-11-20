import { describe, expect, it } from "vitest";
import { receiptLinkLabel } from "../receipt-link";

describe("receiptLinkLabel", () => {
  it("names what the link opens from its host", () => {
    expect(receiptLinkLabel("https://github.com/acme/site/pull/12")).toBe("View pull request");
    expect(receiptLinkLabel("https://admin.mailchimp.com/campaigns/show/?id=9")).toBe("View campaign");
  });
  it("calls a live LinkedIn post a post, on any LinkedIn subdomain, and not on a look-alike host", () => {
    expect(receiptLinkLabel("https://www.linkedin.com/feed/update/urn:li:share:7392")).toBe("View post");
    expect(receiptLinkLabel("https://linkedin.com/feed/update/urn:li:share:7392")).toBe("View post");
    expect(receiptLinkLabel("https://notlinkedin.com/feed/update/x")).toBe("View it");
    expect(receiptLinkLabel("https://linkedin.com.evil.example/x")).toBe("View it");
    expect(receiptLinkLabel("http://www.linkedin.com/feed/update/x")).toBe("View it");
  });
  it("falls back to View it", () => {
    expect(receiptLinkLabel("https://example.com/x")).toBe("View it");
    expect(receiptLinkLabel("not a url")).toBe("View it");
    expect(receiptLinkLabel("https://notgithub.com/x")).toBe("View it");
  });
});
