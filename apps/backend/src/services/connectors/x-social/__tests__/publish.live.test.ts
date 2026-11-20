import { describe, it, expect } from "vitest";
import { isXSocialConnected, publishXText } from "../publish";
import { xSocialReadPostMetricsTool } from "@/services/tools/x-social/read_post_metrics";
import { getConnectorToken } from "@/services/connectors/core/token";
import { getSecret } from "@/services/secrets/vault";
import { forceRefreshConnector } from "@/services/connectors/core/token";

const LIVE = process.env.LIVE_X_PUBLISH === "1";
const TENANT = process.env.LIVE_X_TENANT ?? "";

describe.skipIf(!LIVE || !TENANT)("LIVE — X connector", () => {
  it("is connected, publishes one post, reads owned metrics", async () => {
    expect(await isXSocialConnected(TENANT)).toBe(true);
    if (process.env.LIVE_X_SKIP_PUBLISH !== "1") {
      const text = `Zavi X rail smoke test ${new Date().toISOString()}`;
      const r = await publishXText(TENANT, text);
      console.log("publish →", JSON.stringify(r));
      expect(r.ok).toBe(true);
      expect(r.raw.id).toBeTruthy();
      console.log("post URL → https://x.com/i/web/status/" + r.raw.id);
    }
    if (process.env.LIVE_X_REFRESH === "1") {
      const before = await getSecret(TENANT, "x_social.refresh_token");
      await forceRefreshConnector(TENANT, "x_social");
      const after = await getSecret(TENANT, "x_social.refresh_token");
      const tok = await getConnectorToken(TENANT, "x_social", "x_social.access_token");
      console.log("force refresh → persisted new refresh token:", after !== before, "access token present:", Boolean(tok));
      expect(tok).toBeTruthy();
    }
    if (process.env.LIVE_X_RAW === "1") {
      const tok = await getConnectorToken(TENANT, "x_social", "x_social.access_token");
      const uid = await getSecret(TENANT, "x_social.user_id");
      const u = `https://api.x.com/2/users/${uid}/tweets?max_results=5&tweet.fields=created_at,public_metrics,non_public_metrics,organic_metrics`;
      const resp = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
      console.log("raw timeline →", resp.status, (await resp.text()).slice(0, 1500));
    }

    const out = await xSocialReadPostMetricsTool.execute({ tenant_id: TENANT, log: console.log } as never, { max_results: 5 });
    console.log("metrics →", JSON.stringify(out, null, 1).slice(0, 2500));
    expect((out as { provenance: string }).provenance).toBe("owned");
  }, 60_000);
});
