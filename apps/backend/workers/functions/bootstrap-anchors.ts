
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { bootstrapAnchors } from "@/services/memory/generate-anchors";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import { MEMORY_SLUGS, type MemoryDocSlug } from "@/services/memory/loader";

export const bootstrapAnchorsFn = inngest.createFunction(
  {
    id: "bootstrap-anchors",
    idempotency: "event.data.tenant_id",
  },
  { event: "tenant.bootstrap_anchors.requested" },
  async ({ event, step }) => {
    const tenant_id = event.data?.tenant_id;
    const seed_text = event.data?.seed_text;
    if (!tenant_id || typeof tenant_id !== "string") {
      throw new Error("bootstrap-anchors: missing tenant_id in event payload");
    }

    const display_name = await step.run("load-tenant-name", async () => {
      const { data } = await serviceClient()
        .from("tenants")
        .select("display_name")
        .eq("id", tenant_id)
        .maybeSingle();
      return (data as { display_name?: string } | null)?.display_name ?? "the company";
    });

    const generated = await step.run("opus-anchors-from-idea", async () =>
      bootstrapAnchors({
        display_name,
        email: null,
        free_text: typeof seed_text === "string" ? seed_text : "",
      }),
    );

    const written = await step.run("write-anchors", async () => {
      let landed = 0;
      for (const slugKey of MEMORY_SLUGS as readonly MemoryDocSlug[]) {
        if (slugKey === "company") {
          const { writeCompanyProse } = await import("@/services/company/brief");
          const wrote = await writeCompanyProse(
            tenant_id,
            generated.bodies[slugKey],
            "provisioning",
            "bootstrap-anchors (tenant provisioning)",
          );
          if (wrote.stored) landed += 1;
          else if (wrote.reason === "error") {
            console.warn(
              `[bootstrap-anchors] company story not stored for ${tenant_id}: ${wrote.error}`,
            );
          }
          continue;
        }
        await upsertAnchor({
          tenant_id,
          slug: slugKey,
          title: `${slugKey}.md`,
          body_markdown: generated.bodies[slugKey],
          source: "agent_write",
        });
        landed += 1;
      }
      return landed;
    });

    return { tenant_id, anchors_written: written };
  },
);
