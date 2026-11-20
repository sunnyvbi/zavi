import { z } from "zod";

export const postImageSizeSchema = z.enum(["feed", "square", "story", "pin"]);
export const postDraftContentSchema = z.object({
  text: z.string().max(100000),
  thread: z.array(z.string().max(10000)).max(25).nullable(),
  variant_index: z.number().int().min(0).max(49).optional(),
  headline: z.string().max(40).optional(),
  image_path: z.string().max(250).optional(),
  size: postImageSizeSchema.optional(),
}).strict();
export const savedPostDraftSchema = postDraftContentSchema.extend({ rendered_image_path: z.string().optional(), variants: z.record(z.string(), z.object({ text: z.string(), thread: z.array(z.string()).nullable() })).optional() });
export type SavedPostDraft = z.infer<typeof savedPostDraftSchema>;
export const postDraftSaveSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  content: postDraftContentSchema.nullable(),
}).strict();
export type PostDraftContent = z.infer<typeof postDraftContentSchema>;
export type PostImageSize = z.infer<typeof postImageSizeSchema>;
export type PostDraftReview = { revision: string; content: SavedPostDraft | null; editable: boolean };
