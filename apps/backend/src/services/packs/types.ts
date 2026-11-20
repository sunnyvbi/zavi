
import { z } from "zod";

export const PackEntityTypeSchema = z.object({
  display: z.string().min(1),
  description: z.string().min(1),
  key_attributes: z.array(z.string().min(1)).min(1),
  pii_fields: z.array(z.string()).default([]),
});

export const PackOutcomeClassesSchema = z.record(
  z.string(),
  z.array(z.string().min(1)).min(1),
);

export const PackConnectorMapSchema = z.record(z.string(), z.unknown());

export const PackSeedSkillSchema = z.object({
  slug: z.string().min(1),
  trigger: z.unknown(),
  condition: z.unknown().optional(),
  action: z.unknown(),
  eval: z.unknown().optional(),
});

export const PackSeedAgentDraftSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  body_markdown: z.string().default(""),
  frontmatter: z.record(z.string(), z.unknown()).default({}),
});

export const PackStatusSchema = z.enum(["preview", "stable", "retired"]);
export type PackStatus = z.infer<typeof PackStatusSchema>;

const PACK_ID_RE = /^[a-z][a-z0-9_]+@\d+\.\d+(?:\.\d+)?$/;
const PACK_SLUG_RE = /^[a-z][a-z0-9_]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export const PackFileSchema = z
  .object({
    id: z.string().regex(PACK_ID_RE, "pack id must match <pack_slug>@<semver>"),
    pack_slug: z.string().regex(PACK_SLUG_RE),
    semver: z.string().regex(SEMVER_RE),
    status: PackStatusSchema,
    display_name: z.string().min(1),
    description: z.string().default(""),
    supersedes: z.string().regex(PACK_ID_RE).nullable().default(null),
    entity_types: z.record(z.string().min(1), PackEntityTypeSchema).refine(
      (m) => Object.keys(m).length > 0,
      "pack must declare at least one entity_type",
    ),
    outcome_classes: PackOutcomeClassesSchema,
    connector_map: PackConnectorMapSchema.default({}),
    seed_skills: z.array(PackSeedSkillSchema).default([]),
    seed_memory: z.record(z.string(), z.string()).default({}),
    seed_agent_drafts: z.array(PackSeedAgentDraftSchema).default([]),
  })
  .superRefine((pack, ctx) => {
    const expectedShort = `${pack.pack_slug}@${pack.semver.replace(/\.0$/, "")}`;
    const expectedFull = `${pack.pack_slug}@${pack.semver}`;
    const expected2 = `${pack.pack_slug}@${pack.semver.split(".").slice(0, 2).join(".")}`;
    if (pack.id !== expectedFull && pack.id !== expected2 && pack.id !== expectedShort) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pack.id (${pack.id}) does not match pack_slug@semver (${expectedFull} or ${expected2})`,
        path: ["id"],
      });
    }
  });

export type PackFile = z.infer<typeof PackFileSchema>;

export type PackRow = {
  id: string;
  pack_slug: string;
  semver: string;
  status: PackStatus;
  display_name: string;
  description: string;
  supersedes: string | null;
  content: PackFile;
  content_hash: string;
  compiled_at: string;
  entity_types: PackFile["entity_types"];
  outcome_classes: PackFile["outcome_classes"];
  connector_map: PackFile["connector_map"];
  seed_skills: PackFile["seed_skills"];
  seed_memory: PackFile["seed_memory"];
  seed_agent_drafts: PackFile["seed_agent_drafts"];
};

export type TenantPackRow = {
  id: string;
  tenant_id: string;
  pack_id: string;
  activated_with_hash: string;
  activated_at: string;
};

export const ActivateTenantPackResultSchema = z.object({
  tenant_pack_id: z.string().uuid().nullable(),
  activated_with_hash: z.string(),
  seeds_inserted: z.number().int(),
});
export type ActivateTenantPackResult = z.infer<typeof ActivateTenantPackResultSchema>;

export const SubjectAliasSchema = z.object({
  pack_id: z.string().regex(PACK_ID_RE),
  entity_type: z.string().min(1),
  external_id: z.string().min(1),
  kind: z.string().default("same_subject"),
  confidence: z.number().min(0).max(1).default(1.0),
  derived_by: z.enum(["manual", "rule", "llm", "embedding_match"]).default("manual"),
});
export type SubjectAlias = z.infer<typeof SubjectAliasSchema>;
