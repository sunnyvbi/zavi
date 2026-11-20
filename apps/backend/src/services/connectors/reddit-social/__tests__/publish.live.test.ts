
import { describe, it, expect } from "vitest";
import { publishRedditSelfPost, isRedditSocialConnected } from "../publish";
import { getSecret } from "@/services/secrets/vault";
import { REDDIT_SOCIAL_USERNAME_KEY } from "../constants";

const GATED = process.env.LIVE_REDDIT_PUBLISH === "1";
const TENANT = process.env.PROBE_TENANT_ID ?? "";

describe("reddit-social — LIVE publish (gated: LIVE_REDDIT_PUBLISH=1)", () => {
  it.skipIf(!GATED || !TENANT)(
    "posts one self-post to the connected account's profile subreddit",
    async () => {
      expect(await isRedditSocialConnected(TENANT), "tenant has no Reddit connection — run the OAuth first").toBe(true);

      const username = await getSecret(TENANT, REDDIT_SOCIAL_USERNAME_KEY);
      expect(username, "connected Reddit username missing from Vault").toBeTruthy();
      const sr = process.env.LIVE_REDDIT_SUBREDDIT || `u_${username}`;

      const stamp = new Date().toISOString().slice(0, 16) + "Z";
      const res = await publishRedditSelfPost(
        TENANT,
        sr,
        `Zavi native Reddit connector — smoke test ${stamp}`,
        "Testing our own publish rail. This post can be deleted.",
      );
      console.log(`\n  Reddit api/submit → HTTP ${res.status}  sr=${sr}`);
      console.log(`  raw: ${JSON.stringify(res.raw).slice(0, 300)}`);
      if (typeof res.raw.url === "string") console.log(`  🔗 ${res.raw.url}\n`);

      expect(res.ok, `Reddit rejected the post: ${JSON.stringify(res.raw).slice(0, 300)}`).toBe(true);
      expect(String(res.raw.name ?? "")).toMatch(/^t3_[a-z0-9]+$/);
      expect(String(res.raw.url ?? "")).toMatch(/^https:\/\/www\.reddit\.com\//);
    },
    60_000,
  );
});
