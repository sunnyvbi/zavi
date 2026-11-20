
import { z } from "zod";
import {
  deliverImage,
  type DeliverImageCtx,
  type DeliverImageResult,
  type GenerateImageAspect,
} from "./deliver-image";
import {
  composeSocialImage,
  SOCIAL_LAYOUTS,
  SOCIAL_ASPECTS,
  type SocialAspect,
  plateAspectFor,
  type SocialLayout,
} from "./social-image/compose";
import { verifyBrandPixels } from "./social-image/verify";
import { safeFilename } from "./image-filename";
import { lookAtOwnerPhotoRender, type OwnerPhotoLook, type OwnerPhotoLookFn } from "./social-image/owner-photo-look";
import { OWNER_PHOTO_BUCKET } from "./owner-photo";
import { resolveBrandKit, type ResolvedBrandKit } from "@/services/brand/resolve-brand-kit";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";

const MAX_POSTS = 3;

const MAX_PANELS = 10;

const MAX_PHOTO_PANELS = 3;

const SLOT_MAX = 120;

const MAX_PHOTO_PICK = 20;

const slot = z.string().trim().max(SLOT_MAX).optional();

const platePromptField = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe("The PHOTOGRAPH only. Never describe text, logos, or badges.");

export const renderSocialImageInputSchema = z
  .object({
    posts: z
      .array(
        z.object({
          plate_prompt: platePromptField.optional(),
          layout: z.enum(SOCIAL_LAYOUTS).default("block"),
          eyebrow: slot,
          headline: slot,
          sub: slot,
          badge: slot,
          foot: slot,
          filename: z.string().trim().max(80).optional(),
        }),
      )
      .min(1)
      .max(MAX_POSTS)
      .optional(),
    panels: z
      .array(
        z.object({
          plate_prompt: platePromptField.optional(),
          layout: z.enum(SOCIAL_LAYOUTS).optional(),
          eyebrow: slot,
          headline: slot,
          sub: slot,
          badge: slot,
          foot: slot,
          filename: z.string().trim().max(80).optional(),
        }),
      )
      .min(2)
      .max(MAX_PANELS)
      .optional(),
    carousel_layout: z.enum(SOCIAL_LAYOUTS).default("dark"),
    aspect_ratio: z.enum(SOCIAL_ASPECTS).default("4:5"),
    use_attached_photo: z.union([z.boolean(), z.number().int().min(1).max(MAX_PHOTO_PICK)]).optional(),
    channel_id: z.string().trim().max(64).optional(),
    thread_ts: z.string().trim().max(64).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.posts === !v.panels) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "provide exactly one of `posts` or `panels`. `posts` = up to 3 ALTERNATIVE " +
          "treatments of one idea for the customer to choose between. `panels` = an " +
          "ordered CAROUSEL, one idea across 2-10 slides they swipe through.",
      });
      return;
    }
    if (photoPick(v) !== null) {
      if (v.posts && v.posts.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "with use_attached_photo, send exactly ONE post: the owner's photo is edited once per call " +
            "(one billed image edit). For another version, call again after the owner has seen this one.",
        });
      }
      if (v.panels && v.panels.slice(1).some((p) => p.plate_prompt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "with use_attached_photo, the owner's photo is the cover (panel 1) and the other panels are " +
            "type cards: remove plate_prompt from every panel after the first.",
        });
      }
      return;
    }
    if (v.posts && v.posts.some((p) => !p.plate_prompt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "every post needs a plate_prompt (the photograph to paint), unless use_attached_photo puts the " +
          "owner's own photo underneath.",
      });
    }
    if (v.panels) {
      const photo = v.panels.filter((p) => p.plate_prompt).length;
      if (photo > MAX_PHOTO_PANELS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `${photo} panels carry a plate_prompt; at most ${MAX_PHOTO_PANELS} may. ` +
            `Each one is a billed image generation. A carousel does not want a photo ` +
            `on every slide — give the cover (and at most ${MAX_PHOTO_PANELS - 1} others) ` +
            `a plate_prompt and leave the rest without one. Those render as pure-type ` +
            `cards in the customer's brand colours, cost nothing, and are what makes the ` +
            `set read as one sequence.`,
        });
      }
    }
  });

export type RenderSocialImageInput = z.infer<typeof renderSocialImageInputSchema>;

export const OWNER_PHOTO_RENDER_TAG = "owner_photo";

export function photoPick(v: { use_attached_photo?: boolean | number }): number | null {
  const u = v.use_attached_photo;
  if (u === true) return 1;
  if (typeof u === "number") return u;
  return null;
}

export type OwnerPhotoPlate = {
  reference: string;
  path: string;
  index: number;
  available: number;
};

export type SocialImageBrand = {
  primary: string;
  accent: string | null;
  source: ResolvedBrandKit["source"];
  source_url: string | null;
  evidence: ResolvedBrandKit["evidence"];
};

export type RenderSocialImageResult = DeliverImageResult & {
  mode: "options" | "carousel";
  brand: SocialImageBrand;
  brand_verified: Array<{ filename: string; hexes: string[] }>;
  owner_photo?: { index: number; of: number; delivered: boolean; check?: OwnerPhotoLook };
};

const SUPPRESSION_TAIL =
  "No text, no letters, no numbers, no logos, no manufacturer badges, no emblems, " +
  "no license plate, no watermark, no people.";

const NEGATIVE_SPACE: Record<SocialLayout, string> = {
  block: "Compose for a crop: the subject sits in the upper two thirds.",
  scrim: "The lower third is plain and uncluttered so text can sit over it.",
  dark: "Shot on a dark, near-black background with generous empty space.",
};

export function platePrompt(prompt: string, layout: SocialLayout): string {
  return `${prompt.trim()} ${NEGATIVE_SPACE[layout]} ${SUPPRESSION_TAIL}`;
}

export function ownerPhotoEditPrompt(note: string | null): string {
  const base =
    "Keep this photograph as it is: the same place, subject, objects, colours and light. " +
    "Do not add, remove, replace or redraw anything in it, and keep any signs or writing already in it exactly as they are. " +
    "Return it clean and sharp. Do not add any new text, letters, numbers, logos or watermark.";
  return note && note.trim() ? `${base} The only change the owner asked for: ${note.trim()}` : base;
}

function fallbackName(i: number, layout: SocialLayout): string {
  return `social-${i + 1}-${layout}.png`;
}

function panelName(i: number, total: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `carousel-${pad(i + 1)}-of-${pad(total)}.png`;
}

type Unit = {
  platePrompt: string | null;
  layout: SocialLayout;
  slots: { eyebrow?: string; headline?: string; sub?: string; badge?: string; foot?: string };
  filename: string;
  counter: { index: number; total: number } | null;
};

function toUnits(input: RenderSocialImageInput): { mode: "options" | "carousel"; units: Unit[] } {
  if (input.panels) {
    const total = input.panels.length;
    return {
      mode: "carousel",
      units: input.panels.map((p, i) => ({
        platePrompt: p.plate_prompt ?? null,
        layout: p.layout ?? input.carousel_layout,
        slots: { eyebrow: p.eyebrow, headline: p.headline, sub: p.sub, badge: p.badge, foot: p.foot },
        filename: p.filename?.trim() || panelName(i, total),
        counter: { index: i + 1, total },
      })),
    };
  }
  const posts = input.posts ?? [];
  return {
    mode: "options",
    units: posts.map((p, i) => ({
      platePrompt: p.plate_prompt ?? null,
      layout: p.layout,
      slots: { eyebrow: p.eyebrow, headline: p.headline, sub: p.sub, badge: p.badge, foot: p.foot },
      filename: p.filename?.trim() || fallbackName(i, p.layout),
      counter: null,
    })),
  };
}

function withStoredNames(
  t: { mode: "options" | "carousel"; units: Unit[] },
  taken: ReadonlySet<string> = new Set(),
): typeof t {
  const used = new Set<string>([...taken].map((n) => n.toLowerCase()));
  const units = t.units.map((u, i) => {
    const base = safeFilename(u.filename, i);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = base.replace(/(\.[^.]+)$/, `-${n}$1`);
    used.add(name.toLowerCase());
    return { ...u, filename: name };
  });
  return { ...t, units };
}

export async function deliverSocialImage(
  ctx: Omit<DeliverImageCtx, "transform" | "task" | "renderTag" | "renderKey"> & {
    ownerPhoto?: OwnerPhotoPlate;
    look?: OwnerPhotoLookFn;
  },
  rawInput: RenderSocialImageInput,
): Promise<RenderSocialImageResult> {
  const input = renderSocialImageInputSchema.parse(rawInput);
  const { mode, units } = withStoredNames(toUnits(input), await runFilenames(ctx.tenant_id, ctx.run_id));
  const { ownerPhoto, look = lookAtOwnerPhotoRender, ...imageCtx } = ctx;
  const usePhoto = photoPick(input) !== null;
  if (usePhoto !== !!ownerPhoto) {
    throw new Error(
      usePhoto
        ? "deliverSocialImage: use_attached_photo set but no owner photo was resolved"
        : "deliverSocialImage: an owner photo was passed without use_attached_photo",
    );
  }
  let photoComposite: Buffer | null = null;
  const kit = await resolveBrandKit(ctx.tenant_id);
  const verifiedBySlot = new Map<number, string[]>();

  const result = await deliverImage(
    {
      ...imageCtx,
      task: usePhoto ? "image.edit" : "image.plate",
      ...(usePhoto ? { renderTag: OWNER_PHOTO_RENDER_TAG } : {}),
      ...(usePhoto
        ? {
            renderKey: JSON.stringify({
              aspect: input.aspect_ratio,
              units: units.map((u) => ({ layout: u.layout, slots: u.slots, counter: u.counter })),
            }),
          }
        : {}),
      stageable: true,
      transform: async (plate, i) => {
        const unit = units[i];
        const composed = await composeSocialImage({
          plate,
          layout: unit.layout,
          aspect: input.aspect_ratio as SocialAspect,
          tokens: { primary: kit.primary, accent: kit.accent, bg: kit.bg, text: kit.text },
          slots: unit.slots,
          counter: unit.counter,
        });

        const v = await verifyBrandPixels(composed.png, composed.usedHexes);
        if (!v.ok) {
          throw new Error(`brand_pixel_verification_failed: ${v.missing.join(",")}`);
        }
        verifiedBySlot.set(i, composed.usedHexes);
        if (usePhoto && i === 0) photoComposite = composed.png;
        return { bytes: composed.png, mime: "image/png" };
      },
    },
    {
      prompts: units.map((u, i) => ({
        prompt:
          usePhoto && i === 0
            ? ownerPhotoEditPrompt(u.platePrompt)
            :
              u.platePrompt === null
              ? null
              : platePrompt(u.platePrompt, u.layout),
        filename: u.filename,
      })),
      aspect_ratio: plateAspectFor(input.aspect_ratio as SocialAspect) as GenerateImageAspect,
      mode: usePhoto ? "edit" : "photo",
      ...(usePhoto ? { reference_url: ownerPhoto!.reference } : {}),
      channel_id: input.channel_id,
      thread_ts: input.thread_ts,
    },
  );

  let owner_photo: RenderSocialImageResult["owner_photo"];
  if (ownerPhoto) {
    const delivered = result.images.some((img) => img.slot === 0);
    owner_photo = { index: ownerPhoto.index, of: ownerPhoto.available, delivered };
    if (delivered && photoComposite) {
      owner_photo.check = await lookOnce(imageCtx.tenant_id, ownerPhoto.path, photoComposite, units[0]!, look);
    }
  }

  return {
    ...result,
    mode,
    ...(owner_photo ? { owner_photo } : {}),
    brand: {
      primary: kit.primary,
      accent: kit.accent,
      source: kit.source,
      source_url: kit.source_url,
      evidence: kit.evidence,
    },
    brand_verified: result.images
      .filter((img) => verifiedBySlot.has(img.slot))
      .map((img) => ({ filename: img.filename, hexes: verifiedBySlot.get(img.slot)! })),
  };
}

async function lookOnce(
  tenantId: string,
  path: string,
  delivered: Buffer,
  unit: Unit,
  look: OwnerPhotoLookFn,
): Promise<OwnerPhotoLook> {
  let original: Buffer;
  try {
    if (!path.toLowerCase().startsWith(`${tenantId.toLowerCase()}/`)) return { status: "not_looked", reason: "error" };
    const dl = await tenantStorage(asTenantId(tenantId)).from(OWNER_PHOTO_BUCKET).download(path);
    if (!dl.data) return { status: "not_looked", reason: "error" };
    original = Buffer.from(await dl.data.arrayBuffer());
  } catch {
    return { status: "not_looked", reason: "error" };
  }
  const words = Object.values(unit.slots)
    .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
    .map((w) => w.replace(/\|/g, " ").trim());
  if (unit.counter) words.push(`${unit.counter.index}/${unit.counter.total}`);
  try {
    return await look({ original, delivered, words });
  } catch {
    return { status: "not_looked", reason: "error" };
  }
}

async function runFilenames(tenantId: string, runId: string): Promise<Set<string>> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("run_artifacts")
      .select("filename")
      .eq("run_id", runId)
      .limit(1000);
    if (error) return new Set();
    return new Set(((data ?? []) as Array<{ filename?: unknown }>).map((r) => String(r.filename ?? "")).filter(Boolean));
  } catch {
    return new Set();
  }
}
