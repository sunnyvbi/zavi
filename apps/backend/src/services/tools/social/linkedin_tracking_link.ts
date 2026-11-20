import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  url: z.string().url().max(4000).describe("The company's chosen destination, preserving its path and query. Do not substitute another page."),
  campaign: z.string().trim().min(1).max(80).describe("A campaign label shared by the requested batch, without personal data."),
  post: z.string().trim().min(1).max(80).describe("A distinct label for this post, such as launch-story or product-walkthrough."),
});

export const linkedinTrackingLinkTool: ToolSpec = {
  name: "social_linkedin_tracking_link",
  effect: "read",
  description: "Build a LinkedIn website link with source, medium, campaign and per-post content tags. Pure URL formatting: no network, no saved data, no publishing. Keeps the destination and existing parameters. Tags alone do not prove analytics is installed or receiving visits. Use the returned URL in the draft before staging it; do not change an exact untagged URL the founder explicitly requested.",
  input_schema: inputSchema,
  execute: async (_ctx, raw) => {
    const input = inputSchema.parse(raw);
    const url = new URL(input.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ExpectedToolError("invalid_tracking_url", "Use a public HTTP or HTTPS destination without embedded credentials.");
    const tags = { utm_source: "linkedin", utm_medium: "organic_social", utm_campaign: input.campaign, utm_content: input.post };
    const preserved: string[] = [];
    for (const [key, value] of Object.entries(tags)) {
      if (url.searchParams.has(key)) preserved.push(key);
      else url.searchParams.set(key, value);
    }
    return { url: url.toString(), tags: Object.fromEntries(Object.keys(tags).map(k => [k, url.searchParams.get(k)])), preserved,
      note: preserved.length ? "Existing tags were preserved. Check that they distinguish this post. Verify a real visit and conversion in your analytics before claiming attribution." : "Use this exact link in the draft. Verify a real visit and conversion in your analytics before claiming attribution." };
  },
};
