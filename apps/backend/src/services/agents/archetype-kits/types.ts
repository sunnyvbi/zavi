
import { z } from "zod";

export const ARCHETYPE_SLUGS = [
  "marketplace",
  "saas-dashboard",
  "landing",
  "shop",
  "blog",
  "booking",
  "crm",
  "community",
  "project-management",
  "directory",
  "fintech-tracker",
] as const;

export type ArchetypeSlug = (typeof ARCHETYPE_SLUGS)[number];

const KitPageSchema = z
  .object({
    route: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1),
    components: z.array(z.string()).default([]),
  })
  .strict();

const KitComponentSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const KitTableSchema = z
  .object({
    name: z.string().min(1),
    purpose: z.string().min(1),
    columns: z.record(z.string(), z.string()),
  })
  .strict();

const VisualDirectionSchema = z
  .object({
    mood: z.string().min(1),
    layout: z.string().min(1),
    accents: z.array(z.string()).default([]),
  })
  .strict();

export const ArchetypeKitSchema = z
  .object({
    slug: z.enum(ARCHETYPE_SLUGS),
    title: z.string().min(1),
    summary: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    pages: z.array(KitPageSchema).min(1),
    components: z.array(KitComponentSchema).min(1),
    schema: z.array(KitTableSchema).min(1),
    seedData: z.array(z.string().min(1)).min(1),
    responsive: z.array(z.string().min(1)).min(1),
    visualDirection: VisualDirectionSchema,
  })
  .strict();

export type ArchetypeKit = z.infer<typeof ArchetypeKitSchema>;

export function parseArchetypeKit(raw: unknown): ArchetypeKit {
  return ArchetypeKitSchema.parse(raw);
}
