
import { z } from "zod";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { channelRecipeStepEnvelopeSchema } from "./channel-recipe-step";
import {
  attributedFigures,
  cutSentencesWithFigures as cutFigureSentences,
  digitsOf,
  sentenceSpans,
  unreadPublicationTitles,
} from "@/services/agents/attributed-figures";
import {
  unsourcedFiguresIn,
  unreadSourcesIn,
  unsourcedRuleClaimsIn,
} from "@/services/reports/unsourced-figure-gate";
import { ledgerIsEmpty } from "@/services/agents/engine/figure-ledger";

const MAX_PAGE_BYTES = 12_000;
const MIN_USABLE_CHARS = 20;

export type GroundingEvidencePage = { url: string; text: string };

export type GroundingEdit = { from: string; to: string };

export type GroundingDeps = {
  enabled: () => boolean;
  pages: (run_id: string) => GroundingEvidencePage[];
  facts: (tenant_id: string) => Promise<Array<{ key: string; value: string }>>;
  resyncArtifacts: (
    tenant_id: string,
    run_id: string,
    edits: GroundingEdit[],
  ) => Promise<{ patched: number; unpatchable: number; unmatched?: number }>;
  log: (code: string, meta: Record<string, number | string | boolean>) => void;
};

export async function groundChannelDeliverables(
  envelope: unknown,
  ctx: AgentContext,
  _payload: unknown,
  result: DispatcherResult,
  deps: GroundingDeps = defaultGroundingDeps(),
): Promise<{ envelope: unknown }> {
  if (!deps.enabled()) return { envelope };
  const parsed = channelRecipeStepEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) return { envelope };

  const targets = parsed.data.steps
    .map((s, i) => ({ i, d: s.deliverable }))
    .filter((t): t is { i: number; d: NonNullable<typeof t.d> } => !!t.d);
  if (targets.length === 0) return { envelope };

  let pages: GroundingEvidencePage[] = [];
  try {
    pages = deps.pages(ctx.runId);
  } catch {
    pages = [];
  }
  let facts: Array<{ key: string; value: string }> = [];
  try {
    facts = await deps.facts(ctx.tenant_id);
  } catch {
    facts = [];
  }
  const toolEvidence = readToolEvidence(result);
  if (pages.length === 0 && toolEvidence.length === 0) {
    deps.log("channel.deliverable_grounding.no_evidence", { deliverables: targets.length });
    return { envelope };
  }

  const steps = parsed.data.steps.map((s) => ({ ...s }));
  let audit = parsed.data.rendered_markdown;
  const edits: GroundingEdit[] = [];

  let figures_cut = 0;
  let figures_kept = 0;
  const titleCorpus = [
    ...facts.map((f) => `${f.key}: ${f.value}`),
    ...pages.map((p) => p.text),
    ...toolEvidence.map((t) => t.text),
  ].join("\n");

  const deterministicBad = (text: string): string[] => [
    ...(ledgerIsEmpty(ctx.runId)
      ? findUnsourcedFigures(text, titleCorpus)
      : unsourcedFiguresIn(ctx.runId, text)),
    ...unreadSourcesIn(ctx.runId, text),
    ...unsourcedRuleClaimsIn(ctx.runId, text),
    ...unreadPublicationTitles(text, titleCorpus),
  ];
  const countedKept = new Set<string>();
  for (const t of targets) {
    const current = steps[t.i].deliverable?.content ?? t.d.content;
    const bad = deterministicBad(current);
    if (bad.length === 0) continue;
    const cut = cutFigureSentences(current, bad);
    if (cut.trim().length < MIN_USABLE_CHARS) {
      for (const b of bad) countedKept.add(b);
      figures_kept = countedKept.size;
      continue;
    }
    steps[t.i] = { ...steps[t.i], deliverable: { ...t.d, content: cut, parts: undefined } };
    audit = replaceAll(audit, current, cut);
    edits.push({ from: current, to: cut });
    figures_cut += bad.length;
  }
  const auditBad = deterministicBad(audit);
  if (auditBad.length > 0) {
    const cutAudit = cutFigureSentences(audit, auditBad);
    if (cutAudit.trim().length >= MIN_USABLE_CHARS) {
      audit = cutAudit;
      figures_cut += auditBad.length;
    } else {
      for (const b of auditBad) countedKept.add(b);
      figures_kept = countedKept.size;
    }
  }

  let artifacts_patched = 0;
  let artifacts_unpatchable = 0;
  let artifacts_unmatched = 0;
  if (edits.length > 0) {
    try {
      const r = await deps.resyncArtifacts(ctx.tenant_id, ctx.runId, edits);
      artifacts_patched = r.patched;
      artifacts_unpatchable = r.unpatchable;
      artifacts_unmatched = r.unmatched ?? 0;
    } catch (e) {
      deps.log("channel.deliverable_grounding.artifact_resync_failed", {
        reason: (e as Error).message.slice(0, 120),
      });
    }
  }

  deps.log("channel.deliverable_grounding.done", {
    artifacts_patched,
    artifacts_unpatchable,
    artifacts_unmatched,
    figures_cut,
    figures_kept,
    deliverables: targets.length,
    evidence_pages: pages.length,
  });

  return { envelope: { ...parsed.data, steps, rendered_markdown: audit } };
}

export function findUnsourcedFigures(text: string, evidence: string): string[] {
  const haystack = digitsOf(evidence);
  return attributedFigures(text).filter((raw) => !haystack.includes(digitsOf(raw)));
}

const EVIDENCE_TOOL = /(web_search|rag_web_browser|scrape_|thread_read|search_videos|video_stats|seo_audit)/;

export function readToolEvidence(result: DispatcherResult | undefined): Array<{ name: string; text: string }> {
  const calls = result?.tool_calls ?? [];
  return calls
    .filter((c) => c.status === "ok" && EVIDENCE_TOOL.test(c.name) && !!c.output_preview)
    .map((c) => ({ name: c.name.replace(/^mcp__server__/, ""), text: c.output_preview }));
}

export { cutFigureSentences as cutSentencesWithFigures };

export function artifactBelongsToTenant(storage_path: string, tenant_id: string): boolean {
  return !!tenant_id && storage_path.startsWith(`${tenant_id}/`);
}

export function patchArtifactText(
  before: string,
  edits: GroundingEdit[],
  escape: (s: string) => string,
): string {
  let after = before;
  for (const e of edits) {
    after = replaceAll(after, e.from, e.to);
    const escFrom = escape(e.from);
    if (escFrom !== e.from) after = replaceAll(after, escFrom, escape(e.to));
  }
  return after;
}

const PATCHABLE_MIME = /^(text\/|application\/json$)/;

export async function resyncRunArtifacts(
  tenant_id: string,
  run_id: string,
  edits: GroundingEdit[],
): Promise<{ patched: number; unpatchable: number; unmatched: number }> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { asTenantId, tenantClient, tenantStorage } = require("@/services/tenant-client") as typeof import("@/services/tenant-client");
  const { ARTIFACT_BUCKET } = require("@/services/sandbox/tool-registry") as typeof import("@/services/sandbox/tool-registry");
  const { escapeHtml } = require("@/services/reports/render-html") as typeof import("@/services/reports/render-html");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tid = asTenantId(tenant_id);
  const { data, error } = await tenantClient(tid)
    .from("run_artifacts")
    .select("storage_path,mime")
    .eq("run_id", run_id);
  if (error || !data || data.length === 0) return { patched: 0, unpatchable: 0, unmatched: 0 };

  let patched = 0;
  let unpatchable = 0;
  let unmatched = 0;
  for (const row of data as Array<{ storage_path: string; mime: string | null }>) {
    if (!artifactBelongsToTenant(row.storage_path, tenant_id)) {
      unpatchable += 1;
      continue;
    }
    const storage = tenantStorage(tid).from(ARTIFACT_BUCKET);
    if (!PATCHABLE_MIME.test(row.mime ?? "")) {
      unpatchable += 1;
      continue;
    }
    const dl = await storage.download(row.storage_path);
    if (dl.error || !dl.data) {
      unpatchable += 1;
      continue;
    }
    const before = await dl.data.text();
    const after = patchArtifactText(before, edits, escapeHtml);
    if (after === before) {
      unmatched += 1;
      continue;
    }
    const up = await storage.upload(row.storage_path, Buffer.from(after, "utf8"), {
      contentType: row.mime ?? "text/plain",
      upsert: true,
    });
    if (up.error) unpatchable += 1;
    else patched += 1;
  }
  return { patched, unpatchable, unmatched };
}

function replaceAll(haystack: string, find: string, put: string): string {
  if (!find || !haystack.includes(find)) return haystack;
  return haystack.split(find).join(put);
}

function defaultGroundingDeps(): GroundingDeps {
  return {
    enabled: () => process.env.CHANNEL_DELIVERABLE_GROUNDING !== "0",
    pages: (run_id) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCaptureLedger } = require("@/services/agents/engine/capture-ledger") as typeof import("@/services/agents/engine/capture-ledger");
      return getCaptureLedger(run_id)
        .filter((e) => (e.capture === "dom_text" || e.capture === "rendered") && !!e.text_snippet)
        .map((e) => ({ url: e.final_url || e.requested_url, text: e.text_snippet as string }));
    },
    facts: async (tenant_id) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCompanyFacts } = require("@/services/company/facts") as typeof import("@/services/company/facts");
      const cf = await getCompanyFacts(tenant_id);
      const out: Array<{ key: string; value: string }> = [];
      if (cf.name && !cf.nameIsWorkspaceLabel) out.push({ key: "name", value: cf.name });
      if (cf.website) out.push({ key: "website", value: cf.website });
      for (const [key, fact] of Object.entries(cf.facts)) {
        if (fact && fact.source !== "ai_estimated") out.push({ key, value: fact.value });
      }
      return out;
    },
    resyncArtifacts: async (tenant_id, run_id, edits) => resyncRunArtifacts(tenant_id, run_id, edits),
    log: (code, meta) => {
      console.info(`[channels.grounding] ${code} ${JSON.stringify(meta)}`);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { logEvent } = require("@/services/logging/logEvent") as typeof import("@/services/logging/logEvent");
      void logEvent({ level: "info", source: "channels.grounding", code, meta }).catch(() => {});
    },
  };
}
