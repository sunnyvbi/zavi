
import { describe, it, expect } from "vitest";
import { listConnectedAccounts } from "@/services/connectors/pipedream/api";
import { publishYouTubeVideoViaPipedream, YT_PIPEDREAM_APP } from "../publish";
import { youtubeInsightsReadTool } from "@/services/tools/youtube-insights/read";

const LIVE = process.env.LIVE_YT_PIPEDREAM === "1";
const TENANT = process.env.LIVE_YT_TENANT ?? "";
const VIDEO = process.env.LIVE_YT_VIDEO_URL ?? "";

describe.skipIf(!LIVE || !TENANT)("LIVE — YouTube via Pipedream Connect", () => {
  it("uploads with the requested privacy (or reveals the audit gate) and reads Analytics", async () => {
    if (process.env.LIVE_YT_SKIP_UPLOAD !== "1" && VIDEO) {
      const accounts = await listConnectedAccounts({ external_user_id: TENANT, app_slug: YT_PIPEDREAM_APP });
      console.log("youtube_data_api accounts:", accounts.length);
      expect(accounts.length).toBeGreaterThan(0);
      const r = await publishYouTubeVideoViaPipedream(
        TENANT,
        accounts[0].id,
        { title: `Zavi YouTube rail smoke test ${new Date().toISOString()}`, description: "Zavi connector test.", privacy: "public" },
        VIDEO,
      );
      console.log("upload →", JSON.stringify(r).slice(0, 1200));
      console.log("AUDIT VERDICT →", JSON.stringify({ requested: (r.raw as Record<string, unknown>).privacy_requested, applied: (r.raw as Record<string, unknown>).privacy_applied }));
      expect(r.ok).toBe(true);
    }

    const out = await youtubeInsightsReadTool.execute({ tenant_id: TENANT, log: console.log } as never, { days: 28, max_videos: 5 });
    console.log("insights →", JSON.stringify(out, null, 1).slice(0, 3000));
    expect((out as { provenance: string }).provenance).toBe("owned");
  }, 300_000);
});
