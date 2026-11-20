
import { tenantClient, asTenantId } from "@/services/tenant-client";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  deliverSocialImage,
  OWNER_PHOTO_RENDER_TAG,
  photoPick,
  renderSocialImageInputSchema,
  type RenderSocialImageInput,
  type RenderSocialImageResult,
} from "@/services/reports/deliver-social-image";
import { resolveOwnerPhoto } from "@/services/reports/owner-photo";

const DESCRIPTION = [
  "Produce ready-to-post SOCIAL CREATIVE (Instagram/LinkedIn/X feed images) with the",
  "customer's OWN brand colours and crisp, exact text burned in. Use this whenever an",
  "image will carry words: promo and coupon posts, launch and milestone announcements,",
  "city/feature launches, hiring cards, ad creative.",
  "",
  "BEFORE YOU CALL THIS FOR AD CREATIVE, READ WHAT IS ALREADY RUNNING. Pull the",
  "advertiser's OWN live ads (`meta_ads__list_ads` with include_creative:true — real",
  "headlines with their real ctr beside them) and what competitors are running",
  "(`apify__scrape_meta_ads`, the Meta Ad Library), whichever of those you hold. The ad",
  "that is already winning is the brief; a headline written from memory is a guess. Any",
  "price or statistic burned into the image must come from a read in THIS run.",
  "",
  "PREFER THIS OVER generate_image FOR ANYTHING WITH TEXT. generate_image asks the model",
  "to draw the words, and image models mangle them — a coupon code comes back with a",
  "letter changed and the brand blue is off by a few points. Here the model paints only",
  "the photograph and the text is typeset by code at the customer's real hexes, then the",
  "output pixels are checked to prove those hexes landed. Use generate_image only for a",
  "plain photograph with no words on it.",
  "",
  "TWO SHAPES. Pass EXACTLY ONE of `posts` or `panels`:",
  "",
  "  `posts` = ALTERNATIVES. Up to 3 different treatments of ONE idea, for the customer",
  "  to pick between. Use when they want a post and you want to give them a choice.",
  "",
  "  `panels` = a CAROUSEL. 2-10 ordered slides telling ONE story the reader swipes",
  "  through. Use whenever the ask is a carousel, a multi-slide post, a 'swipe' post, a",
  "  step-by-step, a listicle, or a teardown. These are a SEQUENCE, not options — panel",
  "  1 is the hook, the middle panels carry one point each, the last is the call to",
  "  action. Do NOT hand a customer 3 alternative covers when they asked for a carousel.",
  "",
  "THE OWNER'S OWN PHOTO. When they attached a photo in this chat and want it used",
  "('put this on my photo', their storefront, their dish), set `use_attached_photo`:",
  "true or 1 = the newest photo they attached in this conversation (of photos sent",
  "together, the last one attached), 2 = the one before.",
  "Zavi finds the file itself: never type, guess or ask for a path. Send ONE post (or a",
  "carousel whose cover is the photo); it is ONE billed image edit that keeps their",
  "photo and puts your words on it. plate_prompt is then optional: only a change they",
  "asked for ('brighten it'). The result's owner_photo.check is Zavi's one look at the",
  "finished image: if ok, say it is done; if not, tell them what it saw and offer to",
  "redo it. Never re-render on your own. An error here (no_attached_photo,",
  "attached_photo_unavailable, ...) means nothing was charged: tell the owner what it",
  "says and do not call again in this turn.",
  "",
  "Common fields (identical on posts[] and panels[]):",
  "  - plate_prompt (string, ≤1000): describe the PHOTOGRAPH ONLY — subject, setting,",
  "    light, mood. Never describe text, a logo, a badge, or a card 'that says'",
  "    something; the words come from the slots below. Leave the subject off-centre so",
  "    the type has room. REQUIRED on posts[] (unless use_attached_photo); OPTIONAL on",
  "    panels[] (see the cap below).",
  "  - layout: 'block' (photo on top, solid brand panel beneath — loudest, best for a",
  "    flat offer) | 'scrim' (full-bleed photo under a gradient, left-aligned — most",
  "    editorial) | 'dark' (dark canvas, photo band — punchiest, best for urgency).",
  "  - eyebrow / headline / sub / badge / foot (string, ≤120 each, all optional): the",
  "    words, rendered VERBATIM. `|` forces a line break in the headline. Put a coupon",
  "    code in `badge` and the expiry in `foot`.",
  "  - filename (optional): defaults are sensible; carousel panels auto-name in running",
  "    order (carousel-01-of-07.png …), so the file list IS the posting order.",
  "",
  "posts[] specifics:",
  "  - 1-3 entries, EACH a billed image generation. For 3, use a different `layout` for",
  "    each so the customer is choosing between genuinely different reads.",
  "",
  "panels[] specifics — READ THE TWO CAPS, they are enforced and rejection wastes a turn:",
  "  - CAP 1: at most 10 panels per call (Instagram's carousel limit).",
  "  - CAP 2: at most 3 panels may carry a `plate_prompt`. Each of those is a billed",
  "    image generation; the rest cost nothing.",
  "  - A panel with NO plate_prompt renders as a pure-type card in the customer's brand",
  "    colours. This is the normal case, not a fallback: a good carousel is one",
  "    photographic cover plus typographic slides. A 7-panel carousel with one photo is",
  "    ONE billed generation. Do not try to put a photo on every slide.",
  "  - carousel_layout (top level, default 'dark') sets the shared look for every panel;",
  "    a panel's own `layout` overrides it. Keep the override rare — one layout across",
  "    the set is what makes it read as one artifact.",
  "  - Every panel gets an automatic 'n/N' pill in the customer's brand colour. Do not",
  "    write '1/7' into a slot yourself; it is drawn for you.",
  "",
  "Top-level fields:",
  "  - aspect_ratio: '4:5' (default, Instagram feed) | '1:1' | '9:16' (stories/reels) |",
  "    '16:9' (1280x720 — YouTube thumbnails and any landscape cover) | '2:3' (1000x1500 — a Pinterest pin).",
  "  - channel_id + thread_ts (optional): also upload to that Slack thread.",
  "",
  "Returns: { images, mode, generated, cached, skipped, brand, brand_verified }.",
  "  - mode = 'options' or 'carousel', echoing which shape you sent.",
  "  - brand.source = 'scrape' means the hexes were read from the customer's own site",
  "    (brand.source_url + brand.evidence say exactly which declaration). 'default' means",
  "    we could NOT read their site and PLATFORM DEFAULT colours were used.",
  "  - brand_verified lists the hexes proven present in each delivered image.",
  "",
  "HONESTY — report exactly what landed. If `skipped` is non-empty, say which posts did",
  "not render and why. If `brand.source` is 'default', TELL the customer the colours are",
  "placeholders and ask for their brand hex or a working site URL — never present a",
  "default palette as their brand. Never claim more images than `images.length`.",
  "",
  "COPY RULES for whatever you write into the slots: nothing fabricated (every number,",
  "date, city and code is supplied by the customer or verified, never invented); no",
  "competitor names; no em dashes. A discount code must be live before the post goes out",
  "— say so if you do not know that it is.",
  "",
  "DELIVERY: each image is attached as a downloadable chip under your message. Refer to",
  "them by filename. The chips are the delivery — do not redirect the customer elsewhere",
  "to fetch them. Delivered images are also kept in the workspace Artifacts page, which you",
  "may mention only if they ask where past files live. There is no 'Files' page. For",
  "a carousel, list the panels in order and say what each one says, so the customer can",
  "upload them in sequence without opening every file.",
  "",
  "Errors: invalid_input, missing_run_ctx, run_lookup_failed, tenant_mismatch,",
  "no_attached_photo, photo_index_out_of_range, attached_photo_unavailable,",
  "owner_photo_render_failed, owner_photo_render_limit, owner_photo_render_unavailable,",
  "owner_photo_render_replay.",
].join("\n");

type RunToolRow = { stage: string; name: string };

const isSelf = (n: string) => n.includes("render_social_image");

async function readRunToolRows(
  run_id: string,
  tenant_id: string,
  newestFirst = false,
): Promise<RunToolRow[] | null> {
  try {
    let q = tenantClient(asTenantId(tenant_id))
      .from("agent_run_events")
      .select("stage,meta")
      .eq("agent_run_id", run_id);
    if (newestFirst) q = q.order("created_at", { ascending: false });
    const { data, error } = await q.limit(300);
    if (error || !data) return null;
    return data.map((e) => {
      const r = e as { stage?: unknown; meta?: { tool_name?: unknown } };
      return { stage: String(r.stage ?? ""), name: String(r.meta?.tool_name ?? "") };
    });
  } catch {
    return null;
  }
}

async function refuseUngroundedCreativeOnce(run_id: string, tenant_id: string): Promise<void> {
  const rows = await readRunToolRows(run_id, tenant_id);
  if (!rows) return;

  const looked = rows.some(
    (r) =>
      r.name &&
      !r.name.includes("report__") &&
      r.name !== "assistant_turn" &&
      r.name !== "ToolSearch",
  );
  if (looked) return;

  const ownAttempts = rows.filter(
    (r) => isSelf(r.name) && r.stage === "tool_use_started",
  ).length;
  if (ownAttempts >= 2) return;

  console.log(`[render_social_image] creative_ungrounded refusal run=${run_id}`);
  throw new ExpectedToolError(
    "creative_ungrounded",
    "You are about to generate creative having read NOTHING this run, so every word on it would come from memory. Read what is already running first, using WHICHEVER of these you hold: `meta_ads__list_ads` (include_creative:true) for the advertiser's own live ads with their ctr; `apify__scrape_meta_ads` for what competitors are running in the Meta Ad Library — it needs NO connector, and its `page_url` reads the customer's own Facebook Page when Meta is not connected; otherwise `web_search__search`, or whatever read this channel already has. Then call this again. A second call goes through even if those reads came back empty or the connector was missing; if that happens, say in your reply that the creative is ungrounded and which read failed.",
  );
}

const MAX_RENDER_CALLS_WITH_OWNER_PHOTO = 3;
const MAX_RENDER_CALLS_ANY_KIND = 8;

const PHOTO_ERRORS = {
  no_attached_photo:
    "No photo is attached in this conversation, so there is nothing to put the words on (a video or a document cannot be the photo). Nothing was charged. Ask the owner to attach the photo in this chat, then call again. Do not guess a path and do not call again in this turn.",
  photo_lookup_failed:
    "Zavi could not read this conversation's attachments just now. Nothing was charged. Tell the owner their photo could not be opened and to try again in a minute; do not call again in this turn.",
  attached_photo_unavailable:
    "The owner's photo could not be opened (it may have been deleted). Nothing was charged. Ask them to attach it again; do not call again until they do.",
} as const;

async function refuseOwnerPhotoRunaway(run_id: string, tenant_id: string): Promise<void> {
  const rows = await readRunToolRows(run_id, tenant_id, true);
  if (!rows) {
    throw new ExpectedToolError(
      "owner_photo_render_unavailable",
      "Zavi could not check this run's history just now, so it did not edit the photo. Nothing was charged. Tell the owner to try again in a minute; do not call again in this turn.",
    );
  }
  const { count: delivered, error: artErr } = await tenantClient(asTenantId(tenant_id))
    .from("run_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run_id)
    .eq("render_input->>tag", OWNER_PHOTO_RENDER_TAG);
  if (artErr || typeof delivered !== "number") {
    throw new ExpectedToolError(
      "owner_photo_render_unavailable",
      "Zavi could not check this run's history just now, so it did not edit the photo. Nothing was charged. Tell the owner to try again in a minute; do not call again in this turn.",
    );
  }
  if (delivered >= MAX_RENDER_CALLS_WITH_OWNER_PHOTO) {
    console.log(`[render_social_image] owner_photo_render_limit run=${run_id} delivered=${delivered}`);
    throw new ExpectedToolError(
      "owner_photo_render_limit",
      `This run has already delivered ${delivered} edits of the owner's photo. Nothing was charged for this call. Stop here: show the owner what was delivered and let them ask for another version.`,
    );
  }
  const calls = rows.filter((r) => isSelf(r.name) && r.stage === "tool_use_started").length;
  if (calls <= MAX_RENDER_CALLS_ANY_KIND) return;
  console.log(`[render_social_image] owner_photo_render_limit run=${run_id} calls=${calls}`);
  throw new ExpectedToolError(
    "owner_photo_render_limit",
    `This run has already called render_social_image ${calls - 1} times. Nothing was charged for this call. Stop here: show the owner what was delivered (or say plainly that it did not work) and let them ask for another version.`,
  );
}

function photoRenderFailure(result: RenderSocialImageResult): ExpectedToolError {
  const s = result.skipped.find((x) => x.index === 0) ?? result.skipped[0];
  if (s?.detail === "reference_unavailable" || s?.detail === "reference_not_owned") {
    return new ExpectedToolError("attached_photo_unavailable", PHOTO_ERRORS.attached_photo_unavailable);
  }
  if (s?.reason === "meter_error") {
    return s.detail === "retry_replay"
      ? new ExpectedToolError(
          "owner_photo_render_replay",
          "This exact edit of the owner's photo was already made earlier in this run and could not be picked up again. Nothing was charged for this call. Tell the owner the post did not come through and that asking again in a new message will make it; do not call again in this turn.",
        )
      : new ExpectedToolError(
          "owner_photo_render_unavailable",
          "Zavi could not record the photo edit safely just now, so it did not make it. Nothing was charged. Tell the owner to try again in a minute; do not call again in this turn.",
        );
  }
  const why: Record<string, string> = {
    insufficient_credits: "the workspace does not have enough credits for one image edit",
    over_daily_cap: "the workspace reached today's image limit",
    not_configured: "Zavi's photo editing is not available right now",
    vendor_out_of_credits: "Zavi's image service is unavailable right now (Zavi's side, not the owner's)",
    refused: "the image service refused to edit this photo",
    deadline: "the edit took too long",
    charge_failed: "Zavi could not record the charge for the edit, so it was not kept",
    preview_render_used: "this preview run already made its images",
  };
  const reason = (s && why[s.reason]) || "the edit did not come back";
  const others = result.images.length
    ? ` The ${result.images.length} type-only panel(s) were made, at no charge, but without the cover they are not the post they asked for.`
    : "";
  return new ExpectedToolError(
    "owner_photo_render_failed",
    `The post on the owner's photo was not made: ${reason}. Nothing was charged for it.${others} Tell the owner exactly that; do not call again in this turn unless they ask.`,
  );
}

export const renderSocialImageTool: ToolSpec<RenderSocialImageInput, RenderSocialImageResult> = {
  name: "report_render_social_image",
  effect: "write",
  description: DESCRIPTION,
  input_schema: renderSocialImageInputSchema,
  async execute(ctx, input) {
    if (!ctx.run_id) {
      throw new ExpectedToolError(
        "missing_run_ctx",
        "report.render_social_image requires an active run_id in context.",
      );
    }
    const pick = photoPick(input);
    if (pick !== null) {
      await refuseOwnerPhotoRunaway(ctx.run_id, ctx.tenant_id);
      const photo = await resolveOwnerPhoto(ctx.tenant_id, ctx.run_id, pick);
      if (!photo.ok) {
        if (photo.code === "photo_index_out_of_range") {
          throw new ExpectedToolError(
            "photo_index_out_of_range",
            `use_attached_photo asked for photo ${pick}, but this conversation has ${photo.available} (1 = the newest). Nothing was charged. Use a number from 1 to ${photo.available}.`,
          );
        }
        throw new ExpectedToolError(photo.code, PHOTO_ERRORS[photo.code]);
      }
      const result = await deliverSocialImage(
        {
          tenant_id: ctx.tenant_id,
          run_id: ctx.run_id,
          slack_team_id: ctx.slack_team_id,
          log: ctx.log,
          ownerPhoto: { reference: photo.reference, path: photo.path, index: photo.index, available: photo.available },
        },
        input,
      );
      if (!result.owner_photo?.delivered) throw photoRenderFailure(result);
      return result;
    }
    await refuseUngroundedCreativeOnce(ctx.run_id, ctx.tenant_id);
    return deliverSocialImage(
      {
        tenant_id: ctx.tenant_id,
        run_id: ctx.run_id,
        slack_team_id: ctx.slack_team_id,
        log: ctx.log,
      },
      input,
    );
  },
};
