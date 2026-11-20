
import { z } from "zod";
import sharp from "sharp";
import { serviceClient } from "@/services/supabase";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { logEvent } from "@/services/logging/logEvent";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import {
  artifactBytesMatchMime,
} from "@/services/agents/sdk/mcp-sandbox";
import { ExpectedToolError } from "@/services/tools/types";
import { figureGuardedText } from "./unsourced-figure-gate";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { normalizeArtifactFilename } from "./filename";
import { renderPdf, PdfRenderError } from "./render-pdf";
import { reportThemeFromBrand, DEFAULT_REPORT_THEME } from "./brand-theme";
import { resolveBrandKit } from "@/services/brand/resolve-brand-kit";
import { buildLogoSvg } from "./build-logo-svg";
import { renderPdfInputSchema, type RenderPdfInput } from "./schema";
import { coerceRenderPdfInput } from "./coerce-input";
import { ARTIFACT_BUCKET, ARTIFACT_MAX_BYTES } from "./constants";
import { estimateCost, isTaskConfigured, routeImage } from "@/services/media-router/router";
import { mediaSlotHash } from "@/services/media-router/keys";
import {
  canAffordMedia,
  flushCharges,
  type PendingCharge,
} from "@/services/media-router/charge";
import { meterPlatformGeneration } from "@/services/mcp/higgsfield-meter";
import {
  unverifiedCaptures,
  type CaptureLedgerEntry,
} from "@/services/agents/engine/capture-ledger";
import { groundingReceipts } from "@/services/agents/engine/grounding-receipt-ledger";
import {
  verifyPlanGrounding,
  detectOwnSystemClaims,
  type PlanTextSurfaces,
} from "@/services/agents/plan-grounding-verifier";
import { checkArtifactClaims } from "./artifact-claim-gate";
import { readConnectorList } from "@/services/connectors/metadata";

const DISCLOSURE_PATTERNS: RegExp[] = [
  /could not load/i,
  /could not verify/i,
  /could not be (?:loaded|verified|retrieved|fetched|accessed|reached)/i,
  /source unavailable/i,
  /unable to (?:load|verify|retrieve|fetch|access|reach)/i,
  /(?:page|site|source) (?:was )?(?:blocked|unreachable|inaccessible)/i,
  /failed to (?:load|fetch|retrieve|access)/i,
];

function disclosureUnits(input: RenderPdfInput): string[] {
  const units: string[] = [];
  for (const s of input.sections) {
    units.push(`${s.heading}\n${s.body_markdown}${s.preformatted ? `\n${s.preformatted}` : ""}`);
    if (s.table) {
      units.push(...s.table.columns, ...s.table.rows.flat());
    }
  }
  return units;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostNamedWithBoundary(haystackLower: string, host: string): boolean {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9.-])${esc}(?![a-z0-9.-])`).test(haystackLower);
}

function undisclosedSources(
  input: RenderPdfInput,
  unverified: CaptureLedgerEntry[],
): string[] {
  const units = disclosureUnits(input).map((u) => ({ raw: u, lower: u.toLowerCase() }));
  return unverified
    .filter((src) => {
      const urls = [src.requested_url, src.final_url].filter(Boolean);
      const hosts = urls
        .map((x) => hostnameOf(x))
        .filter((h): h is string => !!h);
      const disclosed = units.some((unit) => {
        const hasPhrase = DISCLOSURE_PATTERNS.some((re) => re.test(unit.raw));
        if (!hasPhrase) return false;
        const namesSource =
          urls.some((x) => unit.lower.includes(x.toLowerCase())) ||
          hosts.some((h) => hostNamedWithBoundary(unit.lower, h));
        return namesSource;
      });
      return !disclosed;
    })
    .map((u) => u.requested_url);
}

const PDF_MIME = "application/pdf";

const HERO_ASPECT = "16:9";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_SECTION_IMAGES = 4;
const MAX_PDF_ARTIFACTS_WITH_IMAGES_PER_RUN = 2;
const IMAGE_GEN_DEADLINE_MS = 120_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const PDFKIT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg"]);

async function fetchImageAsBuffer(
  url: string,
  log?: DeliverPdfCtx["log"],
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!PDFKIT_IMAGE_MIMES.has(ct)) {
      log?.(`section image fetch dropped: unsupported content-type ${ct || "(missing)"}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch (e) {
    log?.(`section image fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function generateSectionImages(
  input: RenderPdfInput,
  meterCtx: { tenant_id: string; run_id: string },
  log?: DeliverPdfCtx["log"],
): Promise<{
  resolved: Array<Buffer | null>;
  generated: number;
  charges: PendingCharge[];
}> {
  const resolved: Array<Buffer | null> = new Array(input.sections.length).fill(null);
  const pending: Array<PendingCharge | null> = new Array(input.sections.length).fill(null);
  const targets = input.sections
    .map((s, i) => ({ i, concept: s.logo_spec ? undefined : s.image_concept }))
    .filter((t): t is { i: number; concept: string } => !!t.concept)
    .slice(0, MAX_SECTION_IMAGES);
  if (targets.length === 0) return { resolved, generated: 0, charges: [] };
  if (!(await isTaskConfigured("image.hero"))) {
    log?.("image generation not configured — delivering pdf without section images");
    return { resolved, generated: 0, charges: [] };
  }

  const tasks = targets.map(async ({ i, concept }) => {
    try {
      const gate = await meterPlatformGeneration({
        tenant_id: meterCtx.tenant_id,
        run_id: meterCtx.run_id,
        surface: "pdf-image",
        index: `${i}:${mediaSlotHash(concept, HERO_ASPECT)}`,
      });
      if (gate.decision !== "charged") {
        log?.(
          `section image ${i} skipped by the higgsfield meter (${gate.decision})${gate.error ? `: ${gate.error}` : ""}`,
        );
        return;
      }
      const req = { prompt: concept, aspect_ratio: HERO_ASPECT } as const;
      if (!(await canAffordMedia(meterCtx.tenant_id, estimateCost("image.hero", req)))) {
        log?.(`image ${i} skipped: insufficient credits`);
        return;
      }
      const gen = await routeImage("image.hero", req);
      if (!gen.ok) {
        log?.(`section image gen failed: ${gen.error}`);
        return;
      }
      const buf = await fetchImageAsBuffer(gen.imageUrl, log);
      if (buf) {
        resolved[i] = buf;
        pending[i] = {
          tenant_id: meterCtx.tenant_id,
          run_id: meterCtx.run_id,
          key: `${meterCtx.run_id}:pdf-image:${i}:${mediaSlotHash(concept, HERO_ASPECT)}`,
          cost_usd: gen.cost_usd,
          task: "image.hero",
          model: gen.model,
        };
      }
    } catch (e) {
      log?.(`section image gen threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((res) => {
    timer = setTimeout(() => res("deadline"), IMAGE_GEN_DEADLINE_MS);
  });
  try {
    const outcome = await Promise.race([
      Promise.allSettled(tasks).then(() => "done" as const),
      deadline,
    ]);
    if (outcome === "deadline") {
      log?.(
        `section image gen hit the ${IMAGE_GEN_DEADLINE_MS}ms deadline — delivering with whatever completed`,
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const embedded = resolved.slice();
  const charges = pending.filter((p, i): p is PendingCharge => !!p && !!embedded[i]);
  return { resolved: embedded, generated: embedded.filter((b) => b !== null).length, charges };
}

const LOGO_RASTER_TARGET_W = 1024;
const LOGO_RASTER_TARGET_H = 520;
const LOGO_RASTER_DEADLINE_MS = 20_000;

export type LogoFailReason =
  | "build_error"
  | "sharp_error"
  | "timeout"
  | "embed_error";

function viewBoxWidth(viewBox: string | undefined): number {
  const w = Number((viewBox ?? "0 0 64 64").split(" ")[2]);
  return Number.isFinite(w) && w > 0 ? w : 64;
}

async function rasterizeSectionSvgs(
  input: RenderPdfInput,
  logCtx: { tenant_id: string; run_id: string },
  log?: DeliverPdfCtx["log"],
): Promise<{ resolved: Array<Buffer | null>; rendered: number }> {
  const resolved: Array<Buffer | null> = new Array(input.sections.length).fill(null);
  const targets = input.sections
    .map((s, i) => ({ i, spec: s.logo_spec }))
    .filter((t): t is { i: number; spec: NonNullable<typeof t.spec> } => !!t.spec);
  if (targets.length === 0) return { resolved, rendered: 0 };

  const logFail = (reason: LogoFailReason) => {
    void logEvent({
      level: "warn",
      source: "reports.logo_render",
      code: "logo_render_failed",
      tenant_id: logCtx.tenant_id,
      run_id: logCtx.run_id,
      meta: { logo_fail_reason: reason },
    });
  };

  const tasks = targets.map(async ({ i, spec }) => {
    let svg: string;
    try {
      svg = buildLogoSvg(spec);
    } catch (e) {
      log?.(`logo build failed for section ${i}: ${e instanceof Error ? e.message : String(e)}`);
      logFail("build_error");
      return;
    }
    try {
      const vbW = viewBoxWidth(spec.viewBox);
      const density = Math.min(
        3072,
        Math.max(96, Math.round((96 * LOGO_RASTER_TARGET_W) / vbW)),
      );
      const png = await sharp(Buffer.from(svg), {
        limitInputPixels: 67_108_864,
        density,
        unlimited: false,
      })
        .resize(LOGO_RASTER_TARGET_W, LOGO_RASTER_TARGET_H, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      if (png.byteLength > 0) resolved[i] = png;
    } catch (e) {
      log?.(`logo raster failed for section ${i}: ${e instanceof Error ? e.message : String(e)}`);
      logFail("sharp_error");
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((res) => {
    timer = setTimeout(() => res("deadline"), LOGO_RASTER_DEADLINE_MS);
  });
  try {
    const outcome = await Promise.race([
      Promise.allSettled(tasks).then(() => "done" as const),
      deadline,
    ]);
    if (outcome === "deadline") {
      log?.(`logo raster hit the ${LOGO_RASTER_DEADLINE_MS}ms deadline — delivering with whatever completed`);
      logFail("timeout");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { resolved, rendered: resolved.filter((b) => b !== null).length };
}

export type DeliverPdfCtx = {
  tenant_id: string;
  run_id: string;
  slack_team_id?: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type DeliverPdfResult = {
  artifact_id: string;
  filename: string;
  bytes: number;
  slack_ok: boolean;
  images_generated: number;
  logo_rendered: number;
  logo_embedded: number;
};

export async function deliverPdf(
  ctx: DeliverPdfCtx,
  rawInput: unknown,
): Promise<DeliverPdfResult> {
  let input: RenderPdfInput;
  try {
    input = renderPdfInputSchema.parse(coerceRenderPdfInput(rawInput));
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ExpectedToolError(
        "invalid_input",
        e.issues.map((er) => er.message).join("; "),
      );
    }
    throw e;
  }

  const guardedTenantId = await assertRunTenantOwnership({
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
  });

  const unverified = unverifiedCaptures(ctx.run_id);
  if (unverified.length > 0) {
    const undisclosed = undisclosedSources(input, unverified);
    if (undisclosed.length > 0) {
      throw new ExpectedToolError(
        "artifact_unverified_source",
        `Refusing to emit this artifact: ${undisclosed.length} source(s) could not be loaded (a browser render was attempted and failed or was unavailable), and the document does not disclose this BY NAME. For EACH unverified source, state "could not load <that url>" in the relevant section or table cell (not a footnote), or remove the claims that depend on it. Undisclosed sources: ${undisclosed.join(", ")}`,
        { unrendered_sources: undisclosed },
      );
    }
  }

  input = {
    ...input,
    sections: input.sections.map((sec) => {
      const flat = [sec.heading, sec.body_markdown, sec.preformatted ?? ""].join("\n");
      const guarded = figureGuardedText(ctx.run_id, flat, ctx.log);
      if (guarded === flat) return sec;
      return { ...sec, body_markdown: figureGuardedText(ctx.run_id, sec.body_markdown, ctx.log) };
    }),
  };

  if (process.env.PLAN_GROUNDING_GATE_ENABLED !== "0") {
    try {
      const surfaces: PlanTextSurfaces = {
        title: input.title,
        sectionText: input.sections.map((s) =>
          [
            s.heading,
            s.body_markdown,
            s.preformatted ?? "",
            s.table
              ? [s.table.columns.join(" "), ...s.table.rows.map((r) => r.join(" "))].join("\n")
              : "",
          ].join("\n"),
        ),
      };
      const receipts = groundingReceipts(ctx.run_id);
      let hasRepoConnector = false;
      try {
        const connectors = await readConnectorList(guardedTenantId);
        hasRepoConnector = connectors.some((c) => c.slug === "github");
      } catch {
        hasRepoConnector = false;
      }
      const grounding = verifyPlanGrounding({ surfaces, receipts, hasRepoConnector });
      if (grounding.verdict === "ungrounded") {
        throw new ExpectedToolError(
          "artifact_ungrounded_system_claims",
          `Refusing to render this plan: it makes claims about YOUR OWN system/code (${grounding.claims
            .slice(0, 3)
            .map((c) => `"${c}"`)
            .join(", ")}) but this run never read the repo to verify them. Before rendering, use github__search_code / github__read_file to confirm what actually exists (and github__list_commits to check history for prior attempts), then correct or remove any claim you cannot ground. Re-render once the claims are verified.`,
          { ungrounded_claims: grounding.claims },
        );
      }
      if (grounding.verdict === "needs_disclosure") {
        throw new ExpectedToolError(
          "artifact_ungrounded_system_claims",
          `Refusing to render this plan: it makes claims about YOUR OWN system/code (${grounding.claims
            .slice(0, 3)
            .map((c) => `"${c}"`)
            .join(", ")}) but no code repository is connected, so they cannot be verified. Either state plainly in the document that this plan is "not code-grounded" (no repo connected), or remove the implementation claims and effort estimates. Then re-render.`,
          { ungrounded_claims: grounding.claims },
        );
      }
    } catch (e) {
      if (e instanceof ExpectedToolError && e.code === "artifact_ungrounded_system_claims") {
        throw e;
      }
      ctx.log?.("plan_grounding_gate_skipped", {
        run_id: ctx.run_id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (process.env.ARTIFACT_CLAIM_GATE_ENABLED !== "0") {
    try {
      const claimSurfaces: PlanTextSurfaces = {
        title: input.title,
        sectionText: input.sections.map((s) =>
          [
            s.heading,
            s.body_markdown,
            s.preformatted ?? "",
            s.table
              ? [s.table.columns.join(" "), ...s.table.rows.map((r) => r.join(" "))].join("\n")
              : "",
          ].join("\n"),
        ),
      };
      const candidateClaims = detectOwnSystemClaims(claimSurfaces);
      if (candidateClaims.length > 0) {
        const verdict = await checkArtifactClaims({
          surfaces: claimSurfaces,
          claims: candidateClaims,
          tenantId: guardedTenantId,
          runId: ctx.run_id,
          agentSlug: "artifact_claim_gate",
        });
        if (verdict.verdict === "refuse") {
          ctx.log?.("artifact_claim_gate_refused", {
            run_id: ctx.run_id,
            finding_count: verdict.findings.length,
            cost_usd: verdict.cost_usd,
          });
          throw new ExpectedToolError(
            "artifact_ungrounded_own_system_claim",
            `Refusing to render: this document states things about YOUR OWN systems as established fact without saying what established them. ${verdict.findings
              .slice(0, 3)
              .map((f) => `"${f.claim}" — ${f.why}`)
              .join(" | ")}. For EACH: either cite the file/source you verified it from, mark it plainly as unverified in the text, or remove it. Claims that two systems are independent, that a component lives in a particular repo, or that something is not built are the ones that ship wrong and that the reader cannot check — verify those against the repo before re-rendering.`,
            { ungrounded_claims: verdict.findings.map((f) => f.claim) },
          );
        }
      }
    } catch (e) {
      if (
        e instanceof ExpectedToolError &&
        e.code === "artifact_ungrounded_own_system_claim"
      ) {
        throw e;
      }
      ctx.log?.("artifact_claim_gate_skipped", {
        run_id: ctx.run_id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const { filename, mime } = normalizeArtifactFilename(input.filename);

  const svc = serviceClient();

  const logo = await rasterizeSectionSvgs(
    input,
    { tenant_id: guardedTenantId, run_id: ctx.run_id },
    ctx.log,
  );
  const logo_rendered = logo.rendered;

  const wantsImages = input.sections.some((s) => !s.logo_spec && !!s.image_concept);
  let images_generated = 0;
  let resolvedImages: Array<Buffer | null> | undefined;
  let imageCharges: PendingCharge[] = [];
  if (wantsImages) {
    const { count } = await svc
      .from("run_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("run_id", ctx.run_id)
      .eq("mime", PDF_MIME);
    if ((count ?? 0) >= MAX_PDF_ARTIFACTS_WITH_IMAGES_PER_RUN) {
      ctx.log?.("per-run pdf image budget reached — delivering text-only");
    } else {
      const gen = await generateSectionImages(
        input,
        { tenant_id: guardedTenantId, run_id: ctx.run_id },
        ctx.log,
      );
      resolvedImages = gen.resolved;
      images_generated = gen.generated;
      imageCharges = gen.charges;
    }
  }

  const mergedImages: Array<Buffer | null> = input.sections.map(
    (_s, i) => logo.resolved[i] ?? resolvedImages?.[i] ?? null,
  );
  const logoIndices = new Set(
    logo.resolved.map((b, i) => (b ? i : -1)).filter((i) => i >= 0),
  );
  const embedded: boolean[] = new Array(input.sections.length).fill(false);

  let theme = DEFAULT_REPORT_THEME;
  try {
    theme = reportThemeFromBrand(await resolveBrandKit(guardedTenantId));
  } catch (e) {
    ctx.log?.("brand_theme_unresolved", {
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await renderPdf(input, mergedImages, embedded, theme);
  } catch (e) {
    if (e instanceof PdfRenderError) {
      throw new ExpectedToolError(e.code, e.message);
    }
    if (e instanceof z.ZodError) {
      throw new ExpectedToolError(
        "invalid_input",
        e.issues.map((er) => er.message).join("; "),
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new ExpectedToolError("pdf_render_failed", msg.slice(0, 300));
  }

  if (bytes.byteLength === 0 || !artifactBytesMatchMime(bytes, mime)) {
    throw new ExpectedToolError(
      "pdf_render_failed",
      "renderer produced bytes that do not look like a PDF.",
    );
  }
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new ExpectedToolError(
      "pdf_too_large",
      `pdf is ${bytes.byteLength} bytes; cap is ${ARTIFACT_MAX_BYTES}.`,
    );
  }

  const storagePath = `${guardedTenantId}/${ctx.run_id}/${filename}`;
  const { error: upErr } = await svc.storage
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, Buffer.from(bytes), {
      contentType: PDF_MIME,
      upsert: true,
    });
  if (upErr) {
    throw new ExpectedToolError("storage_upload_failed", upErr.message);
  }

  const binding = await artifactRunBinding(ctx.run_id);
  const { data: rowData, error: rowErr } = await svc
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        storage_path: storagePath,
        filename,
        title: input.title,
        mime: PDF_MIME,
        bytes: bytes.byteLength,
        agent_slug: binding.agent_slug,
        thread_id: binding.thread_id,
        render_input: input,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single();
  if (rowErr || !rowData) {
    throw new ExpectedToolError(
      "artifact_row_failed",
      rowErr?.message ?? "row upsert failed",
    );
  }
  const artifact_id = (rowData as { id: string }).id;
  trackDocumentDelivered({ tenant_id: guardedTenantId, mime: "application/pdf", kind: "report" });

  await flushCharges(imageCharges).catch(() => undefined);

  let slack_ok = false;
  if (input.channel_id) {
    try {
      const uploaded = await uploadFileToThread({
        tenant_id: guardedTenantId,
        channel_id: input.channel_id,
        thread_ts: input.thread_ts,
        bytes,
        filename,
        title: input.title,
        team_id: ctx.slack_team_id,
      });
      slack_ok = true;
      await svc
        .from("run_artifacts")
        .update({
          slack_delivered: true,
          slack_file_id: uploaded.file_id,
          slack_channel_id: input.channel_id,
          slack_thread_ts: input.thread_ts ?? null,
          slack_team_id: ctx.slack_team_id ?? null,
        })
        .eq("tenant_id", guardedTenantId)
        .eq("run_id", ctx.run_id)
        .eq("filename", filename);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log?.(`slack delivery soft-failed: ${msg}`);
      await logEvent({
        level: "warn",
        source: "slack.artifact_delivery",
        code: "inline_delivery_soft_failed",
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        error: e,
      });
    }
  }

  let logo_embedded = 0;
  for (const i of logoIndices) if (embedded[i]) logo_embedded++;
  if (logo_embedded < logo_rendered) {
    void logEvent({
      level: "warn",
      source: "reports.logo_render",
      code: "logo_render_failed",
      tenant_id: guardedTenantId,
      run_id: ctx.run_id,
      meta: { logo_fail_reason: "embed_error" satisfies LogoFailReason },
    });
  }

  return {
    artifact_id,
    filename,
    bytes: bytes.byteLength,
    slack_ok,
    images_generated,
    logo_rendered,
    logo_embedded,
  };
}
