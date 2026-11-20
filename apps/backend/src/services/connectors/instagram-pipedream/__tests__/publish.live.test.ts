
import { describe, it, expect } from "vitest";
import { listConnectedAccounts } from "@/services/connectors/pipedream/api";
import { publishInstagramImageViaPipedream, resolveIgUserId, IG_PIPEDREAM_APP } from "../publish";
import { instagramReadInsightsTool } from "@/services/tools/instagram/read_insights";

const LIVE = process.env.LIVE_IG_PIPEDREAM === "1";
const TENANT = process.env.LIVE_IG_TENANT ?? "";
const IMAGE = process.env.LIVE_IG_IMAGE_URL ?? "";

describe.skipIf(!LIVE || !TENANT)("LIVE — Instagram via Pipedream Connect", () => {
  it("resolves the linked IG account, publishes one captioned image, reads insights", async () => {
    const accounts = await listConnectedAccounts({ external_user_id: TENANT, app_slug: IG_PIPEDREAM_APP });
    expect(accounts.length).toBeGreaterThan(0);
    const who = await resolveIgUserId({ tenantId: TENANT, accountId: accounts[0].id });
    console.log("resolveIgUserId →", JSON.stringify(who));
    expect(who.ok).toBe(true);

    if (IMAGE) {
      const r = await publishInstagramImageViaPipedream(
        TENANT,
        accounts[0].id,
        `Zavi Instagram rail smoke test ${new Date().toISOString()}`,
        IMAGE,
      );
      console.log("publish →", JSON.stringify(r));
      expect(r.ok).toBe(true);
    }

    const out = await instagramReadInsightsTool.execute({ tenant_id: TENANT, log: console.log } as never, { max_posts: 5 });
    console.log("insights →", JSON.stringify(out, null, 1).slice(0, 3000));
    expect((out as { provenance: string }).provenance).toBe("owned");
  }, 120_000);
});
