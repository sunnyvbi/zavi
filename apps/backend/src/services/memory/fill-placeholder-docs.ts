
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import type { MemoryDocSlug } from "./loader";
import { regenerateAnchor } from "./generate-anchors";
import { upsertAnchorGuarded } from "./upsert-anchor";

const PLACEHOLDER_DOC_SLUGS: Readonly<Record<string, readonly MemoryDocSlug[]>> = {
  "support-lead": ["policies", "disputes", "support"],
  "dispute-response": ["disputes"],
};

export function placeholderDocSlugsFor(agent_slug: string): readonly MemoryDocSlug[] {
  return PLACEHOLDER_DOC_SLUGS[agent_slug] ?? [];
}

export type FillPlaceholderDocsResult = {
  filled: MemoryDocSlug[];
  refused: MemoryDocSlug[];
  failed: MemoryDocSlug[];
};

type ReadAnchorRows = (
  tenant_id: string,
  slugs: readonly MemoryDocSlug[],
) => Promise<Array<{ slug?: string; source?: string; metadata?: unknown }>>;

async function readAnchorRows(tenant_id: string, slugs: readonly MemoryDocSlug[]) {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("memory_note")
    .select("slug, source, metadata")
    .in("slug", [...slugs])
    .is("superseded_by", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ slug?: string; source?: string; metadata?: unknown }>;
}

type Deps = {
  readRows?: ReadAnchorRows;
  regenerate?: typeof regenerateAnchor;
  upsertGuarded?: typeof upsertAnchorGuarded;
};

export async function fillPlaceholderDocs(
  tenant_id: string,
  agent_slug: string,
  deps: Deps = {},
): Promise<FillPlaceholderDocsResult> {
  const result: FillPlaceholderDocsResult = { filled: [], refused: [], failed: [] };
  const slugs = placeholderDocSlugsFor(agent_slug);
  if (slugs.length === 0) return result;

  const regenerate = deps.regenerate ?? regenerateAnchor;
  const upsertGuarded = deps.upsertGuarded ?? upsertAnchorGuarded;

  let placeholders: MemoryDocSlug[];
  try {
    const rows = await (deps.readRows ?? readAnchorRows)(tenant_id, slugs);
    placeholders = slugs.filter((slug) =>
      rows.some(
        (r) =>
          r.slug === slug &&
          r.source === "onboarding_seed" &&
          (r.metadata as { seed?: unknown } | null)?.seed === "placeholder",
      ),
    );
  } catch (e) {
    await safeLog(tenant_id, "placeholder_docs_read_failed", e, agent_slug);
    return result;
  }

  const outcomes = await Promise.allSettled(
    placeholders.map(async (slug) => {
      const gen = await regenerate({ tenant_id, slug, persist: false });
      const write = await upsertGuarded(
        {
          tenant_id,
          slug,
          title: `${slug}.md`,
          body_markdown: gen.body_markdown,
          source: "onboarding_seed",
          metadata: {
            seed: "ai",
            ...(gen.key_facts !== undefined ? { key_facts: gen.key_facts } : {}),
          },
        },
        ["onboarding_seed"],
      );
      return write ? "filled" : "refused";
    }),
  );

  for (let i = 0; i < placeholders.length; i++) {
    const slug = placeholders[i];
    const o = outcomes[i];
    if (o.status === "fulfilled") {
      (o.value === "filled" ? result.filled : result.refused).push(slug);
    } else {
      result.failed.push(slug);
      await safeLog(tenant_id, "placeholder_doc_fill_failed", o.reason, agent_slug);
    }
  }
  return result;
}

async function safeLog(tenant_id: string, code: string, err: unknown, agent_slug: string) {
  try {
    await logEvent({
      level: "warn",
      source: "memory.fill-placeholder-docs",
      code,
      tenant_id,
      error: err instanceof Error ? err : new Error(String(err)),
      meta: { agent_slug },
    });
  } catch {
    console.warn(`[fill-placeholder-docs] ${code} for tenant ${tenant_id}`);
  }
}
