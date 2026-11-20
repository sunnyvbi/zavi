
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec, ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import {
  createCreativeBodySchema,
  launchCtaSchema,
  updateCreativeBodySchema,
  uploadAssetBodySchema,
} from "./_decision-bodies";

type Emit = (decision_class: string, body: unknown) => Promise<string>;

async function preflight(ctx: ToolContext): Promise<Emit> {
  if (!(await isMetaAdsWriteEnabled())) {
    throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
  }
  if (typeof ctx.emit_decision !== "function") {
    throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
  }
  return ctx.emit_decision;
}

function originOf(ctx: ToolContext): { origin: "user_initiated_chat" } | Record<string, never> {
  return isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {};
}

function httpsOf(url: string | undefined): string | undefined {
  return url?.replace(/^http:\/\//i, "https://");
}

function parsedOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ExpectedToolError("meta_ads_invalid_creative_body", `This ${what} cannot be made as specified: ${r.error.issues.map((i) => i.message).join(" | ")}`);
  }
  return r.data;
}

const creativeInput = z.object({
  creative_id: z.string().optional().describe("Only to RENAME an existing creative (with new_name)."),
  new_name: z.string().optional(),
  name: z.string().optional().describe("The new creative's name (or, with creative_id, its current name for the card)."),
  primary_text: z.string().optional(),
  headline: z.string().optional(),
  link_url: z.string().optional().describe("The https landing page."),
  cta: launchCtaSchema.optional(),
  image_url: z.string().optional().describe("A public https image (e.g. one report__render_social_image returned)."),
  image_hash: z.string().optional().describe("An image already in the account (list_creative_assets kind images)."),
  video_asset_id: z.string().optional().describe("A video already in the account (list_creative_assets kind videos)."),
  source_ad_id: z.string().optional().describe("Reuse this ad's image or video with new words."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeCreativeTool: ToolSpec = {
  name: "meta_ads_propose_creative",
  effect: "write",
  description:
    "Propose a reusable Meta ad creative (words, link, button and one image or video) without an ad, to swap an ad onto or launch later; or rename one (creative_id + new_name). Spends nothing. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: creativeInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = creativeInput.parse(input);
    if (a.creative_id) {
      const body = parsedOrThrow(
        updateCreativeBodySchema,
        { creative_id: a.creative_id, new_name: a.new_name, name: a.name, about: a.about, rationale: a.rationale, ...originOf(ctx) },
        "rename",
      );
      const decision_id = await emit("meta_ads.update_creative", body);
      return { decision_id, decision_class: "meta_ads.update_creative", notice: "Sent to approvals." };
    }
    const { creative_id: _c, new_name: _n, ...rest } = a;
    const body = parsedOrThrow(createCreativeBodySchema, { ...rest, image_url: httpsOf(rest.image_url), ...originOf(ctx) }, "creative");
    const decision_id = await emit("meta_ads.create_creative", body);
    return { decision_id, decision_class: "meta_ads.create_creative", notice: "Sent to approvals. Once approved, the creative id comes back on the card." };
  },
};

const assetInput = z.object({
  kind: z.enum(["image", "video"]),
  url: z.string().describe("A public https URL of the file."),
  name: z.string().min(1).max(200),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeAssetUploadTool: ToolSpec = {
  name: "meta_ads_propose_asset_upload",
  effect: "write",
  description:
    "Propose putting an image or video into the Meta ad account's library, so creatives can use it by hash or video id. Spends nothing. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: assetInput,
  async execute(ctx, input) {
    const emit = await preflight(ctx);
    const a = assetInput.parse(input);
    const body = parsedOrThrow(uploadAssetBodySchema, { ...a, url: httpsOf(a.url), ...originOf(ctx) }, "upload");
    const decision_id = await emit("meta_ads.upload_asset", body);
    return { decision_id, decision_class: "meta_ads.upload_asset", notice: "Sent to approvals." };
  },
};
