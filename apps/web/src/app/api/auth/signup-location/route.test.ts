import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
const secret = "local-test-secret-not-real-credentials-123456";
beforeEach(() => {
  vi.stubEnv("SIGNUP_LOCATION_SIGNING_SECRET", secret);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.zaviagent.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const request = (
  headers: Record<string, string> = {},
  body: unknown = { email: "user@example.com" },
) =>
  new NextRequest("https://www.zaviagent.com/api/auth/signup-location", {
    method: "POST",
    headers: {
      origin: "https://www.zaviagent.com",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
it("signs only CloudFront location and decodes provider city names", async () => {
  const r = await POST(
    request(
      {
        "cloudfront-viewer-country": "BR",
        "cloudfront-viewer-city": "S%C3%A3o%20Paulo",
      },
      { email: "user@example.com", city: "forged" },
    ),
  );
  const { ticket } = await r.json();
  expect(JSON.parse(ticket.payload)).toMatchObject({
    country: "BR",
    city: "São Paulo",
  });
  expect(ticket.signature).toHaveLength(64);
  expect(r.headers.get("cache-control")).toContain("no-store");
});
it("keeps missing location unknown instead of trusting client input", async () => {
  const r = await POST(
    request({}, { email: "user@example.com", country: "IN", city: "Pune" }),
  );
  expect(await r.json()).toEqual({ ticket: null });
});
it("rejects cross-origin requests", async () => {
  expect(
    (await POST(request({ origin: "https://attacker.example" }))).status,
  ).toBe(403);
});
it("does not stop signup when the signing configuration is absent", async () => {
  vi.stubEnv("SIGNUP_LOCATION_SIGNING_SECRET", "");
  expect(await (await POST(request())).json()).toEqual({ ticket: null });
});
