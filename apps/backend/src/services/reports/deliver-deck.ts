
import { z } from "zod";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { logEvent } from "@/services/logging/logEvent";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import { ExpectedToolError } from "@/services/tools/types";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { normalizeArtifactFilename } from "./filename";
import { ARTIFACT_BUCKET, ARTIFACT_MAX_BYTES } from "./constants";
import { renderDeckInputSchema, type RenderDeckInput } from "./deck-schema";
import { renderDeckHtml } from "./render-deck-html";
import { renderDeckPdf, DeckRenderError } from "./render-deck-pdf";
import { deckThemeFromBrand, DEFAULT_DECK_THEME } from "./brand-theme";
import { resolveBrandKit } from "@/services/brand/resolve-brand-kit";
import { publishDeckLink } from "@/services/agents/prototype-links";

const PDF_MIME = "application/pdf";

export type DeliverDeckCtx = {
  tenant_id: string;
  run_id: string;
  slack_team_id?: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type DeliverDeckResult = {
  url: string | null;
  slug: string | null;
  link_error?: "disabled" | "blocked" | "error";
  artifact_id: string;
  filename: string;
  bytes: number;
  slides: number;
  slack_ok: boolean;
};

export async function deliverDeck(
  ctx: DeliverDeckCtx,
  rawInput: unknown,
): Promise<DeliverDeckResult> {
  let input: RenderDeckInput;
  try {
    input = renderDeckInputSchema.parse(rawInput);
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
  const tid = asTenantId(guardedTenantId);
  const db = tenantClient(tid);

  let deckTheme = DEFAULT_DECK_THEME;
  try {
    deckTheme = deckThemeFromBrand(await resolveBrandKit(guardedTenantId));
  } catch (e) {
    ctx.log?.("brand_theme_unresolved", {
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
  }

  let html: string;
  let pdfBytes: Buffer;
  try {
    html = renderDeckHtml(input, deckTheme);
    pdfBytes = Buffer.from(await renderDeckPdf(input, deckTheme));
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ExpectedToolError(
        "invalid_input",
        e.issues.map((er) => er.message).join("; "),
      );
    }
    if (e instanceof DeckRenderError) {
      throw new ExpectedToolError(e.code, e.message);
    }
    throw new ExpectedToolError(
      "deck_render_failed",
      (e instanceof Error ? e.message : String(e)).slice(0, 300),
    );
  }

  if (pdfBytes.byteLength === 0 || pdfBytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new ExpectedToolError(
      "deck_render_failed",
      "renderer produced bytes that are not a PDF.",
    );
  }
  if (pdfBytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new ExpectedToolError(
      "deck_too_large",
      `deck pdf is ${pdfBytes.byteLength} bytes; cap is ${ARTIFACT_MAX_BYTES}.`,
    );
  }

  const link = await publishDeckLink({
    tenant_id: guardedTenantId,
    run_id: ctx.run_id,
    title: input.title,
    summary: input.subtitle ?? `${input.slides.length}-slide deck.`,
    html,
  });
  if (!link.published) {
    ctx.log?.(`deck link not published (${link.reason}${link.detail ? `: ${link.detail}` : ""})`);
  }

  const { filename } = normalizeArtifactFilename(input.filename);
  const storagePath = `${guardedTenantId}/${ctx.run_id}/${filename}`;
  const { error: upErr } = await tenantStorage(tid)
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, pdfBytes, { contentType: PDF_MIME, upsert: true });
  if (upErr) {
    throw new ExpectedToolError("storage_upload_failed", upErr.message);
  }

  const binding = await artifactRunBinding(ctx.run_id);
  const { data: rowData, error: rowErr } = await db
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        storage_path: storagePath,
        filename,
        title: input.title,
        mime: PDF_MIME,
        bytes: pdfBytes.byteLength,
        agent_slug: binding.agent_slug,
        thread_id: binding.thread_id,
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
  trackDocumentDelivered({ tenant_id: guardedTenantId, mime: "application/pdf", kind: "deck" });

  let slack_ok = false;
  if (input.channel_id) {
    try {
      await uploadFileToThread({
        tenant_id: guardedTenantId,
        channel_id: input.channel_id,
        thread_ts: input.thread_ts,
        bytes: pdfBytes,
        filename,
        title: input.title,
        team_id: ctx.slack_team_id,
      });
      slack_ok = true;
      await db
        .from("run_artifacts")
        .update({ slack_delivered: true })
        .eq("run_id", ctx.run_id)
        .eq("filename", filename);
    } catch (e) {
      ctx.log?.(`slack delivery soft-failed: ${e instanceof Error ? e.message : String(e)}`);
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

  return {
    url: link.published ? link.url : null,
    slug: link.published ? link.slug : null,
    ...(link.published ? {} : { link_error: link.reason }),
    artifact_id,
    filename,
    bytes: pdfBytes.byteLength,
    slides: input.slides.length,
    slack_ok,
  };
}
