
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  company_name: z
    .string()
    .min(1)
    .max(100)
    .describe("The company name — used to derive the repo slug."),
  stack: z
    .string()
    .min(1)
    .describe("Build stack (e.g. nextjs-supabase-tailwind)."),
  dry_run: z
    .boolean()
    .default(true)
    .describe("Must be true in v1. Real creation is E3-gated."),
});

export type ProvisionRepoInput = z.infer<typeof inputSchema>;

export type ProvisionRepoResult = {
  dry_run: true;
  created: false;
  repo_full_name: string;
  repo_url: string;
  default_branch: string;
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

export const provisionRepoTool: ToolSpec<ProvisionRepoInput, ProvisionRepoResult> = {
  name: "provision_repo",
  effect: "write",
  description:
    "Simulate provisioning a GitHub repository for a new company. DRY-RUN only in v1 — returns simulated identifiers, creates nothing real.",
  input_schema: inputSchema,
  async execute(_ctx, input: unknown): Promise<ProvisionRepoResult> {
    const { company_name, stack } = inputSchema.parse(input);
    const slug = slugify(company_name);
    return {
      dry_run: true,
      created: false,
      repo_full_name: `praxis-built/${slug}`,
      repo_url: `https://github.com/praxis-built/${slug}`,
      default_branch: "main",
      stack,
      note: "DRY-RUN: no real GitHub repository was created. Real creation is E3-gated.",
    };
  },
};
