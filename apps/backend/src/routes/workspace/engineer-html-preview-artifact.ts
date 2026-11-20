import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import {
  loadReadyHtmlPreview,
  markHtmlPreviewDisplayed,
} from "@/services/agents/html-preview-artifacts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getEngineerHtmlPreviewArtifact(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const preview_id = String(req.params.previewId ?? "");
  if (!UUID_RE.test(preview_id)) {
    res.status(400).json({
      error: { code: "bad_preview_id", message: "Invalid preview id." },
    });
    return;
  }

  const preview = await loadReadyHtmlPreview({
    tenant_id: auth.tenant_id,
    preview_id,
  });
  if (!preview) {
    res.status(404).json({
      state: "html_preview_failed",
      failure_reason: "artifact_missing",
    });
    return;
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).json({
    version: 2,
    kind: "html_preview",
    state: "html_preview_ready",
    preview_id: preview.row.id,
    title: preview.row.title,
    summary: preview.row.summary,
    html: preview.html,
  });
}

export async function acknowledgeEngineerHtmlPreviewDisplayed(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const preview_id = String(req.params.previewId ?? "");
  if (!UUID_RE.test(preview_id)) {
    res.status(400).json({
      error: { code: "bad_preview_id", message: "Invalid preview id." },
    });
    return;
  }

  const preview = await loadReadyHtmlPreview({
    tenant_id: auth.tenant_id,
    preview_id,
  });
  if (!preview) {
    res.status(404).json({
      state: "html_preview_failed",
      failure_reason: "artifact_missing",
    });
    return;
  }

  const displayed = await markHtmlPreviewDisplayed({
    tenant_id: auth.tenant_id,
    preview_id,
  });
  if (!displayed) {
    res.status(404).json({
      state: "html_preview_failed",
      failure_reason: "artifact_missing",
    });
    return;
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).json({ state: "html_preview_ready", displayed: true });
}
