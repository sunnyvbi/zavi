
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import raw from "./job-prices.json";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

const MatchSchema = z
  .object({
    agent: z.array(z.string()).min(1).optional(),
    agent_prefix: z.string().min(1).optional(),
    agent_group: z.literal("channels").optional(),
    trigger: z.array(z.string()).min(1).optional(),
    payload: z.record(z.string(), z.union([Scalar, z.array(Scalar).min(1)])).optional(),
    payload_absent: z.array(z.string()).optional(),
    dedupe_key_prefix: z.string().min(1).optional(),
  })
  .strict()
  .refine((m) => m.agent || m.agent_prefix || m.agent_group, "a rule must name its agent(s)");

const JobSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    label: z.string().min(1),
    credits: z.number().int().min(0),
    free: z.boolean().optional(),
    match: MatchSchema,
    basis: z.record(z.string(), z.unknown()),
  })
  .strict();

const MediaSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    label: z.string().min(1),
    credits: z.number().int().min(0),
    tasks: z.array(z.string()).min(1),
    basis: z.record(z.string(), z.unknown()),
  })
  .strict();

export const JobPricesSchema = z
  .object({
    $comment: z.string(),
    version: z.number().int(),
    credits_per_usd: z.number().positive(),
    jobs: z.array(JobSchema).min(1),
    media: z.array(MediaSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = [...cfg.jobs.map((j) => j.id), ...cfg.media.map((m) => m.id)];
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `duplicate job id: ${dup}` });
    const tasks = cfg.media.flatMap((m) => m.tasks);
    const dupTask = tasks.find((t, i) => tasks.indexOf(t) !== i);
    if (dupTask) ctx.addIssue({ code: "custom", message: `media task priced twice: ${dupTask}` });
  });

export type JobPrices = z.infer<typeof JobPricesSchema>;
export type JobPrice = JobPrices["jobs"][number];

export const JOB_PRICES: JobPrices = JobPricesSchema.parse(raw);

const CHANNELS_ROOT = path.join(process.cwd(), "src", "channels");

let channelSlugs: Set<string> | null = null;
export function channelAgentSlugs(): Set<string> {
  if (!channelSlugs) {
    channelSlugs = new Set(
      fs
        .readdirSync(CHANNELS_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_") && fs.existsSync(path.join(CHANNELS_ROOT, d.name, "recipe.md")))
        .map((d) => d.name),
    );
  }
  return channelSlugs;
}

export interface JobFacts {
  agent_slug: string;
  trigger: string;
  payload?: Record<string, unknown> | null;
  cron_dedupe_key?: string | null;
}

function asText(v: unknown): string | null {
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function matches(job: JobPrice, f: JobFacts): boolean {
  const m = job.match;
  if (m.agent && !m.agent.includes(f.agent_slug)) return false;
  if (m.agent_prefix && !f.agent_slug.startsWith(m.agent_prefix)) return false;
  if (m.agent_group === "channels" && !channelAgentSlugs().has(f.agent_slug)) return false;
  if (m.trigger && !m.trigger.includes(f.trigger)) return false;
  if (m.dedupe_key_prefix && !(f.cron_dedupe_key ?? "").startsWith(m.dedupe_key_prefix)) return false;
  const p = f.payload ?? {};
  for (const [k, want] of Object.entries(m.payload ?? {})) {
    const got = asText(p[k]);
    const wants = (Array.isArray(want) ? want : [want]).map(String);
    if (got === null || !wants.includes(got)) return false;
  }
  for (const k of m.payload_absent ?? []) {
    if (asText(p[k]) !== null) return false;
  }
  return true;
}

const FOUNDER_PAYLOAD_TRIGGERS = new Set(["manual", "chat", "mcp"]);

export function priceForJob(f: JobFacts, cfg: JobPrices = JOB_PRICES): JobPrice | null {
  const hit = cfg.jobs.find((j) => matches(j, f)) ?? null;
  if (!hit || !FOUNDER_PAYLOAD_TRIGGERS.has(f.trigger)) return hit;
  const floor = cfg.jobs.find((j) => matches(j, { ...f, payload: null })) ?? null;
  return floor && floor.credits > hit.credits ? floor : hit;
}

export function priceForMedia(task: string, cfg: JobPrices = JOB_PRICES): JobPrices["media"][number] | null {
  return cfg.media.find((m) => m.tasks.includes(task)) ?? null;
}

export function billedMediaUsdFor(task: string, vendorUsd: number, flatOn: boolean, cfg: JobPrices = JOB_PRICES): number {
  if (!(vendorUsd > 0)) return vendorUsd;
  const price = priceForMedia(task, cfg);
  if (!price || !flatOn) return vendorUsd;
  return (price.credits * 25) / 10000;
}
