
import type { Request, Response } from "express";
import { z } from "zod";
import { getChannel } from "@zavi/shared";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { getCompanyFacts } from "@/services/company/facts";

export const QUEUE_QUESTIONS = {
  quick: ["WORTH_NOW", "STEPS_FOLLOWABLE"],
  technical: ["TRUE", "RIGHT_GOAL"],
} as const;
export type Queue = keyof typeof QUEUE_QUESTIONS;
export const DEFAULT_BATCH_SIZE = 200;
export const TECHNICAL_N = 100;
export const PILOT = 20;
const WINDOW_DAYS = 30;
const PER_CALL_OUTPUT = 6000;
const EVIDENCE_CHARS = 60000;

export const LABELLERS = [
  { key: "ravi", name: "Ravi", user_id: "3d9a3fe0-96f9-4423-be53-086b1bae75e7" },
  { key: "tarun", name: "Tarun", user_id: "c0dcacb5-a86e-4600-834c-56dda2af1aae" },
  { key: "pallabi", name: "Pallabi", user_id: "300bc1cb-4534-4ab6-8962-9512f8e001fa" },
] as const;

export function labellerId(as: unknown, loginId: string): string | null {
  if (as === undefined || as === null || as === "") return loginId;
  return LABELLERS.find((l) => l.key === as)?.user_id ?? null;
}

const db = () => staffCrossTenantClient("card labelling queue: staff label channel cards across tenants");

export type Candidate = { id: string; tenant_id: string; channel_slug: string; proposed_at: string };

export function stratifiedSample<T extends Candidate>(rows: T[], n: number): T[] {
  const groups = new Map<string, T[]>();
  for (const r of [...rows].sort((a, b) => b.proposed_at.localeCompare(a.proposed_at))) {
    const k = `${r.tenant_id}|${r.channel_slug}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < n) out.push(l[i]);
  }
  return out;
}

export type Snapshot = { title: string; step: unknown; how_to: unknown; proposed_at: string; tenant_id: string; channel_slug: string; run_id: string | null };
export type Item = { position: number; action_id: string; overlap: boolean; technical: boolean; snapshot?: Snapshot };

const GENERIC_STEP = [/make the change this card describes/i, /^check that it worked, then press /i];

export function stepsKind(howTo: unknown): "real" | "generic" | "none" {
  const steps = Array.isArray(howTo) ? howTo.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
  if (!steps.length) return "none";
  return steps.every((s) => GENERIC_STEP.some((re) => re.test(s))) ? "generic" : "real";
}

const PERFORMANCE =
  /\b(spend|spent|campaigns?|ctr|cpc|cpm|cpa|roas|impressions|clicks|conversions?|ad sets?|budget|reach|engagement( rate)?|sign-?ups?|sales|purchases?|leads?|traffic|bounce rate|installs?|bookings?)\b/i;

export function rightGoalApplies(step: unknown): boolean {
  const s = (step ?? {}) as { title?: string; body?: string };
  return PERFORMANCE.test(`${s.title ?? ""}\n${s.body ?? ""}`);
}

export function pickTechnical(items: { action_id: string; snapshot: Snapshot }[], n: number): Set<string> {
  const picked = new Set<string>();
  for (const it of items) if (picked.size < n && rightGoalApplies(it.snapshot.step)) picked.add(it.action_id);
  for (const it of items) if (picked.size < n) picked.add(it.action_id);
  return picked;
}

const SENTENCE = /[^.!?]+[.!?]+(\s|$)/g;

export function gist(body: unknown, sentences = 3, max = 360): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const first = text.match(SENTENCE)?.slice(0, sentences).join("").trim() || text;
  return first.length > max ? `${first.slice(0, max - 3)}...` : first;
}

export function companyLines(facts: { key: string; value_text: string | null }[]): string[] {
  const get = (k: string) => facts.find((f) => f.key === k)?.value_text?.replace(/\*\*/g, "").trim() || null;
  const about = get("what_we_sell") ?? get("company_story");
  const lines: string[] = [];
  if (about) {
    const sentences = about.match(SENTENCE)?.slice(0, 2).join("").trim() || about;
    lines.push(sentences.length > 320 ? `${sentences.slice(0, 317)}...` : sentences);
  }
  const serves = get("who_we_serve");
  if (serves) lines.push(`Serves: ${serves.length > 200 ? `${serves.slice(0, 197)}...` : serves}`);
  return lines;
}

export function siteUrl(site: string | null): string | null {
  if (!site) return null;
  return /^https?:\/\//i.test(site) ? site : `https://${site.replace(/^\/+/, "")}`;
}

type ToolCall = { name?: string; status?: string; input_preview?: string; output_preview?: string };

export function evidenceBlocks(toolCalls: unknown): { blocks: { tool: string; input: string; output: string }[]; clipped: boolean } {
  const calls = Array.isArray(toolCalls) ? (toolCalls as ToolCall[]) : [];
  const blocks: { tool: string; input: string; output: string }[] = [];
  let total = 0;
  let clipped = false;
  for (const c of calls) {
    if (c.status && c.status !== "ok" && c.status !== "success") continue;
    let output = String(c.output_preview ?? "");
    if (output.length > PER_CALL_OUTPUT) {
      output = output.slice(0, PER_CALL_OUTPUT);
      clipped = true;
    }
    const tool = String(c.name ?? "tool");
    const input = String(c.input_preview ?? "").slice(0, 300);
    const blockLen = `### ${tool}\ninput: ${input}\noutput:\n${output}\n`.length;
    if (total + blockLen > EVIDENCE_CHARS) {
      clipped = true;
      break;
    }
    total += blockLen;
    blocks.push({ tool, input, output });
  }
  if (calls.some((c) => String(c.output_preview ?? "").length >= 8000)) clipped = true;
  return { blocks, clipped };
}

export function fetchedUrls(toolCalls: unknown): string[] {
  const urls: string[] = [];
  for (const c of Array.isArray(toolCalls) ? (toolCalls as ToolCall[]) : []) {
    if (!/web_fetch/.test(String(c.name)) || (c.status && c.status !== "ok")) continue;
    const m = String(c.input_preview ?? "").match(/https?:\/\/[^\s"'\\]+/);
    if (m && !urls.includes(m[0])) urls.push(m[0]);
  }
  return urls.slice(0, 5);
}

export function queueItems(items: Item[], queue: Queue): Item[] {
  return items.filter((it) => queue === "quick" || it.technical).sort((a, b) => a.position - b.position);
}

export function answeredIn(answers: unknown, queue: Queue): boolean {
  const a = (answers ?? {}) as Record<string, unknown>;
  return QUEUE_QUESTIONS[queue].every((q) => typeof a[q] === "string");
}

type Batch = { id: string; created_at: string; created_by: string };

async function activeBatch(): Promise<Batch | null> {
  const { data, error } = await db()
    .from("card_label_batch")
    .select("id, created_at, created_by")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Batch>();
  if (error) throw new Error(error.message);
  return data;
}

async function batchItems(batchId: string): Promise<Item[]> {
  const { data, error } = await db()
    .from("card_label_item")
    .select("position, action_id, overlap, technical, snapshot")
    .eq("batch_id", batchId)
    .order("position", { ascending: true })
    .limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}

async function myQueue(batchId: string, userId: string, queue: Queue) {
  const mine = queueItems(await batchItems(batchId), queue);
  const { data: labels, error: lErr } = await db()
    .from("card_label")
    .select("action_id, answers")
    .eq("batch_id", batchId)
    .eq("labeller", userId)
    .limit(2000);
  if (lErr) throw new Error(lErr.message);
  const existing = new Map((labels ?? []).map((l) => [l.action_id as string, l.answers as Record<string, unknown>]));
  const done = new Set([...existing].filter(([, a]) => answeredIn(a, queue)).map(([id]) => id));
  return { mine, done, existing };
}

export function peopleProgress(
  items: Item[],
  labels: { labeller: string; action_id: string; answers: unknown }[],
  queue: Queue,
): { key: string; name: string; total: number; done: number }[] {
  const ids = new Set(queueItems(items, queue).map((i) => i.action_id));
  return LABELLERS.map((p) => ({
    key: p.key,
    name: p.name,
    total: ids.size,
    done: labels.filter((l) => l.labeller === p.user_id && ids.has(l.action_id) && answeredIn(l.answers, queue)).length,
  }));
}

async function allPeople(batchId: string, queue: Queue) {
  const { data, error } = await db()
    .from("card_label")
    .select("labeller, action_id, answers")
    .eq("batch_id", batchId)
    .in("labeller", LABELLERS.map((l) => l.user_id))
    .limit(10000);
  if (error) throw new Error(error.message);
  return peopleProgress(await batchItems(batchId), (data ?? []) as { labeller: string; action_id: string; answers: unknown }[], queue);
}

const QueueParam = z.enum(["quick", "technical"]).catch("quick");

export async function staffCardLabelsNext(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const queue = QueueParam.parse(req.query.queue);
  const labeller = labellerId(req.query.as, staff.user_id);
  if (!labeller) {
    res.status(400).json({ error: { code: "unknown_labeller", message: "Pick Ravi, Tarun or Pallabi." } });
    return;
  }
  const batch = await activeBatch();
  if (!batch) {
    res.json({ batch: null, queue });
    return;
  }
  const isCreator = batch.created_by === staff.user_id;
  const [{ mine, done }, people] = await Promise.all([myQueue(batch.id, labeller, queue), allPeople(batch.id, queue)]);
  const progress = { total: mine.length, done: mine.filter((m) => done.has(m.action_id)).length };
  const next = mine.find((m) => !done.has(m.action_id));
  if (!next) {
    res.json({ batch: { id: batch.id, is_creator: isCreator }, queue, progress, people, card: null });
    return;
  }

  const card = next.snapshot;
  if (!card) throw new Error("batch item has no snapshot");
  const step = (card.step ?? {}) as { title?: string; body?: string; deliverable?: { label?: string; content?: string } | null; evidence?: unknown };

  const company = await getCompanyFacts(card.tenant_id);
  const factRows = Object.entries(company.facts).map(([key, f]) => ({ key, value_text: f?.value ?? null }));
  const channel = getChannel(card.channel_slug);

  const base = {
    id: next.action_id,
    pilot: next.overlap,
    title: card.title,
    body: step.body ?? "",
    gist: gist(step.body),
    deliverable: step.deliverable?.content ? { label: step.deliverable.label ?? null, content: step.deliverable.content } : null,
    how_to: Array.isArray(card.how_to) ? card.how_to : [],
    steps_kind: stepsKind(card.how_to),
    proposed_at: card.proposed_at,
    company: { name: company.name ?? "Unknown company", site: siteUrl(company.website), about: companyLines(factRows) },
    channel: { slug: card.channel_slug, label: channel?.name ?? card.channel_slug, description: channel?.description ?? null },
  };
  if (queue === "quick") {
    res.json({ batch: { id: batch.id, is_creator: isCreator }, queue, progress, people, card: base });
    return;
  }

  const runRes = card.run_id
    ? await db().from("agent_runs").select("tool_calls").eq("id", card.run_id).maybeSingle()
    : { data: null, error: null };
  if (runRes.error) throw new Error(runRes.error.message);
  res.json({
    batch: { id: batch.id, is_creator: isCreator },
    queue,
    progress,
    people,
    card: {
      ...base,
      based_on: Array.isArray(step.evidence) ? step.evidence.map(String) : step.evidence ? [String(step.evidence)] : [],
      facts: factRows.filter((f) => f.value_text).map((f) => ({ key: f.key, value: String(f.value_text).slice(0, 400) })),
      right_goal_applies: rightGoalApplies(card.step),
      evidence: evidenceBlocks((runRes.data as { tool_calls?: unknown } | null)?.tool_calls),
      live_pages: fetchedUrls((runRes.data as { tool_calls?: unknown } | null)?.tool_calls),
    },
  });
}

const Answer = z.enum(["yes", "no", "skip"]);
const LabelBody = z.object({
  queue: z.enum(["quick", "technical"]),
  as: z.string().max(40).optional(),
  answers: z.record(z.string(), Answer),
  auto: z.array(z.string()).max(4).optional(),
  note: z.string().max(1000).nullable().optional(),
});

export async function staffCardLabelsSave(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const ids = z.object({ batch_id: z.string().uuid(), action_id: z.string().uuid() }).safeParse(req.params);
  const body = LabelBody.safeParse(req.body);
  if (!ids.success || !body.success) {
    res.status(400).json({ error: { code: "invalid_body", message: (ids.error ?? body.error)?.message } });
    return;
  }
  const { queue, answers, auto = [], note } = body.data;
  const labeller = labellerId(body.data.as, staff.user_id);
  if (!labeller) {
    res.status(400).json({ error: { code: "unknown_labeller", message: "Pick Ravi, Tarun or Pallabi." } });
    return;
  }
  const wanted: readonly string[] = QUEUE_QUESTIONS[queue];
  const keys = Object.keys(answers);
  if (keys.length !== wanted.length || !wanted.every((q) => keys.includes(q)) || !auto.every((q) => wanted.includes(q))) {
    res.status(400).json({ error: { code: "invalid_answers", message: `The ${queue} queue answers exactly: ${wanted.join(", ")}.` } });
    return;
  }
  const { batch_id, action_id } = ids.data;
  const { data: batch } = await db().from("card_label_batch").select("id").eq("id", batch_id).maybeSingle();
  if (!batch) {
    res.status(404).json({ error: { code: "batch_not_found", message: "No such labelling batch." } });
    return;
  }
  const { mine, existing } = await myQueue(batch_id, labeller, queue);
  if (!mine.some((m) => m.action_id === action_id)) {
    res.status(403).json({ error: { code: "not_your_card", message: "This card is not in this labelling queue." } });
    return;
  }
  const prev = existing.get(action_id) ?? {};
  const prevAuto = Array.isArray(prev._auto) ? (prev._auto as string[]).filter((q) => !wanted.includes(q)) : [];
  const merged = { ...prev, ...answers, _auto: [...prevAuto, ...auto] };
  const { error } = await db()
    .from("card_label")
    .upsert(
      {
        batch_id,
        action_id,
        labeller,
        answers: merged,
        note: note?.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "batch_id,action_id,labeller" },
    );
  if (error) throw new Error(error.message);
  res.json({ ok: true });
}

const BatchBody = z.object({ size: z.number().int().min(10).max(500).optional() });

export async function staffCardLabelsCreateBatch(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = BatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const size = parsed.data.size ?? DEFAULT_BATCH_SIZE;
  const current = await activeBatch();
  if (current && current.created_by !== staff.user_id) {
    res.status(409).json({ error: { code: "batch_owned", message: "Only the person who started the current batch can start a new one." } });
    return;
  }
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const { data: rows, error } = await db()
    .from("channel_actions")
    .select("id, tenant_id, channel_slug, proposed_at")
    .gte("proposed_at", since)
    .neq("status", "displaced")
    .order("proposed_at", { ascending: false })
    .limit(10000);
  if (error) throw new Error(error.message);
  const sample = stratifiedSample((rows ?? []) as Candidate[], size);
  if (!sample.length) {
    res.status(409).json({ error: { code: "no_cards", message: `No cards proposed in the last ${WINDOW_DAYS} days.` } });
    return;
  }
  const snapshots = new Map<string, Snapshot>();
  for (let i = 0; i < sample.length; i += 50) {
    const ids = sample.slice(i, i + 50).map((c) => c.id);
    const { data: full, error: fErr } = await db()
      .from("channel_actions")
      .select("id, tenant_id, channel_slug, run_id, title, proposed_at, how_to, step:body->step")
      .in("id", ids);
    if (fErr) throw new Error(fErr.message);
    for (const r of full ?? []) {
      const step = r.step as { how_to?: unknown } | null;
      snapshots.set(r.id as string, {
        title: r.title as string,
        step: r.step,
        how_to: Array.isArray(r.how_to) && r.how_to.length ? r.how_to : (step?.how_to ?? null),
        proposed_at: r.proposed_at as string,
        tenant_id: r.tenant_id as string,
        channel_slug: r.channel_slug as string,
        run_id: (r.run_id as string | null) ?? null,
      });
    }
  }
  const frozen = sample.filter((c) => snapshots.has(c.id)).map((c) => ({ action_id: c.id, snapshot: snapshots.get(c.id)! }));
  const technical = pickTechnical(frozen, TECHNICAL_N);
  const { data: batch, error: bErr } = await db()
    .from("card_label_batch")
    .insert({ created_by: staff.user_id })
    .select("id")
    .single<{ id: string }>();
  if (bErr || !batch) throw new Error(bErr?.message ?? "batch insert failed");
  const { error: iErr } = await db()
    .from("card_label_item")
    .insert(
      frozen.map((c, position) => ({
        batch_id: batch.id,
        position,
        action_id: c.action_id,
        overlap: position < PILOT,
        technical: technical.has(c.action_id),
        snapshot: c.snapshot,
      })),
    );
  if (iErr) {
    await db().from("card_label_batch").delete().eq("id", batch.id);
    throw new Error(iErr.message);
  }
  res.json({ batch: { id: batch.id, size: frozen.length, technical: technical.size, pilot: Math.min(PILOT, frozen.length) } });
}
