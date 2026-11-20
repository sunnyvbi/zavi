
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VariantConfigSchema, type VariantConfig } from "../engine/variant-config";

export type FileVariant = {
  slug: string;
  label: string;
  source: "local";
  file: string;
  config?: VariantConfig;
  error?: string;
};

const FileSchema = z
  .object({
    label: z.string().refine((s) => s.trim().length > 0, "must not be empty"),
    config: VariantConfigSchema,
  })
  .strict();

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const DEFAULT_AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

export function loadFileVariants(agentSlug: string, agentsRoot: string = DEFAULT_AGENTS_ROOT): FileVariant[] {
  if (!/^[a-z0-9_-]{1,64}$/.test(agentSlug)) return [];
  const dir = path.join(agentsRoot, agentSlug, "variants");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((f) => {
    const slug = f.slice(0, -".json".length);
    const file = path.join(dir, f);
    const bad = (error: string): FileVariant => ({ slug, label: slug, source: "local", file, error });
    if (!NAME_RE.test(slug) || slug === "default") return bad("bad file name (lowercase letters, digits, - or _)");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      return bad(`unreadable: ${(e as Error).message}`);
    }
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      const where = i?.path.length ? i.path.join(".") : "file";
      const label =
        raw && typeof raw === "object" && typeof (raw as { label?: unknown }).label === "string"
          ? ((raw as { label: string }).label.trim() || slug)
          : slug;
      return { ...bad(`invalid file: ${where} ${i?.message ?? "schema"}`), label };
    }
    return { slug, label: parsed.data.label.trim(), source: "local", file, config: parsed.data.config };
  });
}
