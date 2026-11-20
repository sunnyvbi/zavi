import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TenantSignupSource, type TenantAttribution } from "./TenantSignupSource";

const affiliate: TenantAttribution = {
  source: "Maya", kind: "affiliate", creator_id: "11111111-aaaa",
  referral_code: "abcdefgh", clicked_at: "2026-11-17T07:21:00Z", source_tag: "cr-demo",
};

it("shows the affiliate, account link, code, UTC click time and accompanying channel tag", () => {
  const html = renderToStaticMarkup(<TenantSignupSource attribution={affiliate} />);
  expect(html).toContain('/creator-network/creators/11111111-aaaa');
  expect(html).toContain('Maya');
  expect(html).toContain('abcdefgh');
  expect(html).toContain('2026-11-17 07:21:00 UTC');
  expect(html).toContain('cr-demo');
});

it("does not turn a free-form creator channel tag into an affiliate account link", () => {
  const html = renderToStaticMarkup(<TenantSignupSource attribution={{ source: "cr-demo", kind: "from", referral_code: null, clicked_at: null, source_tag: "cr-demo" }} />);
  expect(html).toContain('Channel code');
  expect(html).toContain('cr-demo');
  expect(html).not.toContain('/creator-network/creators/');
});

it("distinguishes a failed or unavailable read from a successfully read Unknown source", () => {
  const unavailable = renderToStaticMarkup(<TenantSignupSource attribution={null} />);
  expect(unavailable).toContain('Source details unavailable');
  expect(unavailable).not.toContain('Unknown');
  const unknown = renderToStaticMarkup(<TenantSignupSource attribution={{ source: "Unknown", kind: "unknown", referral_code: null, clicked_at: null, source_tag: null }} />);
  expect(unknown).toContain('Unknown');
  expect(unknown).not.toContain('Source details unavailable');
});

it("escapes untrusted labels and tolerates an invalid timestamp", () => {
  const html = renderToStaticMarkup(<TenantSignupSource attribution={{ ...affiliate, source: '<img src=x onerror=alert(1)>', clicked_at: 'invalid' }} />);
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('Invalid Date');
});

it("does not suggest retrying when an older backend omits attribution", () => {
  expect(renderToStaticMarkup(<TenantSignupSource />)).toBe("");
});
