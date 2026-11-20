
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DomainsView } from "./WebsiteConsole";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

function render(deployedUrl: string | null) {
  return renderToStaticMarkup(<DomainsView deployedUrl={deployedUrl} />);
}

describe("DomainsView", () => {
  it("never shows the hosting provider's host while the app has no Zavi address", () => {
    const html = render("https://example.onrender.com/");
    expect(html).not.toContain("onrender");
    expect(html).toContain("No URL yet");
    expect(html).not.toContain("Copy URL");
  });

  it("renders the live app URL host with copy + open affordances", () => {
    const html = render("https://app.example.com/");
    expect(html).toContain("app.example.com");
    expect(html).toContain("Copy URL");
    expect(html).toContain("Open app URL in a new tab");
  });

  it("renders the copy button without a hover tooltip wrapper", () => {
    const html = render("https://app.example.com/");
    expect(html).toMatch(/<button[^>]*aria-label="Copy URL"/);
    expect(html).not.toMatch(/<span class="inline-flex"><button[^>]*aria-label="Copy URL"/);
    expect(html).toMatch(/<span class="inline-flex"><a[^>]*aria-label="Open app URL in a new tab"/);
  });

  it("styles the copy button as a borderless ghost with a rounded hover chip", () => {
    const html = render("https://app.example.com/");
    const copy = html.match(/<button[^>]*aria-label="Copy URL"[^>]*>/);
    expect(copy).toBeTruthy();
    const cls = copy![0].match(/class="([^"]*)"/)![1].split(" ");
    expect(cls).toContain("rounded-cta");
    expect(cls).toContain("hover:bg-[#f0f0f0]");
    expect(cls.some((c) => c === "border" || c.startsWith("border-"))).toBe(false);
    expect(cls).not.toContain("bg-white");
  });

  it("offers an editable Built-in URL (Base44-style Edit URL control)", () => {
    const html = render("https://example.onrender.com/");
    expect(html).toContain("Built-in URL");
    expect(html).toContain("Edit URL");
    expect(html).not.toContain("can’t be changed");
  });

  it("shows the empty state when nothing is deployed yet", () => {
    const html = render(null);
    expect(html).toContain("No URL yet");
  });

  it("renders the real custom-domains add control (not a coming-soon/upsell stub)", () => {
    const html = render("https://example.onrender.com/");
    expect(html).toContain("app.yourcompany.com");
    expect(html).toContain("Add domain");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain("View Plans");
    expect(html).not.toContain("Builder plan");
  });

  it("invites a root domain as well as a subdomain", () => {
    const html = render("https://example.onrender.com/");
    expect(html).toContain("yourcompany.com or app.yourcompany.com");
    expect(html).not.toContain("Apex domains aren");
  });

  it("no longer renders the fictional email-domain card", () => {
    const html = render("https://example.onrender.com/");
    expect(html).not.toContain("Email domain");
    expect(html).not.toContain("no-reply@");
  });

  it("does not link to a nonexistent docs page", () => {
    expect(render(null)).not.toContain("Learn more");
  });
});
