
import { describe, it, expect } from "vitest";
import { publishLinkedInText, isLinkedInSocialConnected } from "../publish";

const GATED = process.env.LIVE_LINKEDIN_PUBLISH === "1";
const TENANT = process.env.PROBE_TENANT_ID ?? "";

describe("linkedin-social — LIVE publish (gated: LIVE_LINKEDIN_PUBLISH=1)", () => {
  it.skipIf(!GATED || !TENANT)(
    "posts one text share to the connected profile and gets an X-RestLi-Id back",
    async () => {
      expect(await isLinkedInSocialConnected(TENANT), "tenant has no LinkedIn connection — run the OAuth first").toBe(true);

      const stamp = new Date().toISOString().slice(0, 16) + "Z";
      const text = `Zavi native LinkedIn connector — smoke test ${stamp}. (Testing our own publish rail; this post can be deleted.)`;

      const res = await publishLinkedInText(TENANT, text);
      console.log(`\n  LinkedIn ugcPosts → HTTP ${res.status}`);
      console.log(`  raw: ${JSON.stringify(res.raw).slice(0, 300)}`);
      if (typeof res.raw.id === "string") {
        console.log(`  🔗 https://www.linkedin.com/feed/update/${res.raw.id}\n`);
      }

      expect(res.ok, `LinkedIn rejected the post: ${JSON.stringify(res.raw).slice(0, 300)}`).toBe(true);
      expect(res.status).toBe(201);
      expect(String(res.raw.id ?? "")).toMatch(/^urn:li:(share|ugcPost):\d+$/);
    },
    60_000,
  );
});
