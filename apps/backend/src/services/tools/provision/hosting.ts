
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  company_name: z
    .string()
    .min(1)
    .max(100)
    .describe("The company name — used to derive the deployment URL slug."),
  stack: z
    .string()
    .min(1)
    .describe("Build stack (e.g. nextjs-supabase-tailwind)."),
  dry_run: z
    .boolean()
    .default(true)
    .describe("Must be true in v1. Real creation is E3-gated."),
});

export type ProvisionHostingInput = z.infer<typeof inputSchema>;

export type ProvisionHostingResult = {
  dry_run: true;
  created: false;
  url: string;
  provider: string;
  stack: string;
  note: string;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export const provisionHostingTool: ToolSpec<ProvisionHostingInput, ProvisionHostingResult> = {
  name: "provision_hosting",
  effect: "write",
  description:
    "Simulate provisioning Vercel hosting for a new company. DRY-RUN only in v1 — returns simulated identifiers, creates nothing real.",
  input_schema: inputSchema,
  async execute(_ctx, input: unknown): Promise<ProvisionHostingResult> {
    const { company_name, stack } = inputSchema.parse(input);
    const slug = slugify(company_name);
    return {
      dry_run: true,
      created: false,
      url: `https://${slug}.vercel.app`,
      provider: "vercel",
      stack,
      note: "DRY-RUN: no real Vercel project was created. Real creation is E3-gated.",
    };
  },
};
