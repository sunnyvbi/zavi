process.env.TZ = "UTC";

import { Inngest } from "inngest";
import { beforeEach } from "vitest";
import { resetLinkedInAdsReadCache } from "./src/services/connectors/linkedin-ads/read-cache";

(Inngest.prototype as unknown as { send: (payload: unknown) => Promise<{ ids: string[] }> }).send = async (payload: unknown) => ({
  ids: (Array.isArray(payload) ? payload : [payload]).map((_, i) => `test-event-${i}`),
});

beforeEach(resetLinkedInAdsReadCache);
