
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { parseUiBlock, splitSources, UI_BLOCK_MIME, type UiBlock } from "@zavi/shared";
import { renderReportPage, reportMarker } from "@/services/shared-pages/report-page";
import { isSignableArtifactBucket, isTenantArtifactPath } from "@/routes/run-artifacts/file-url";
import {
  deckToolEnabled,
  generateSlug,
  prototypeLinkBaseUrl,
  scanArtifactForLeaks,
} from "@/services/agents/prototype-links";
import {
  createSharedPage,
  hardenPageHtml,
  readSharedPageHtml,
  SHARED_PAGE_FIELDS,
  SHARED_PAGE_TTL_DAYS,
  type SharedPageRow,
} from "@/services/shared-pages/page";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SharedPageView = {
  id: string;
  run_id: string;
  title: string;
  visibility: "private" | "public";
  public_url: string | null;
  expires_at: string | null;
  created_at: string;
};

export function presentSharedPage(row: SharedPageRow, now = Date.now()): SharedPageView {
  const live =
    row.status === "public" &&
    !!row.slug &&
    !!row.expires_at &&
    new Date(row.expires_at).getTime() > now;
  return {
    id: row.id,
    run_id: row.run_id,
    title: row.title,
    visibility: live ? "public" : "private",
    public_url: live ? `${prototypeLinkBaseUrl()}/${row.slug}` : null,
    expires_at: live ? row.expires_at : null,
    created_at: row.created_at,
  };
}

async function readOwnedPage(tenantId: string, id: string): Promise<SharedPageRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("shared_pages")
    .select(SHARED_PAGE_FIELDS)
    .eq("id", id)
    .maybeSingle<SharedPageRow>();
  if (error) throw new Error(error.message);
  return data ?? null;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Page not found." } });
}

export async function listSharedPages(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const runId = String(req.query.run_id ?? "");
  if (!UUID_RE.test(runId)) {
    res.status(400).json({ error: { code: "bad_run_id", message: "run_id must be a uuid." } });
    return;
  }
  const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
    .from("shared_pages")
    .select(SHARED_PAGE_FIELDS)
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.status(200).json({ pages: ((data ?? []) as SharedPageRow[]).map((r) => presentSharedPage(r)) });
}

export async function getSharedPage(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.setHeader("Cache-Control", "no-store");
  const row = await readOwnedPage(auth.tenant_id, String(req.params.id ?? ""));
  if (!row) return notFound(res);
  const html = await readSharedPageHtml(auth.tenant_id, row.storage_path);
  if (html === null) return notFound(res);
  res.status(200).json({ page: presentSharedPage(row), html: hardenPageHtml(html) });
}

export async function publishSharedPage(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const row = await readOwnedPage(auth.tenant_id, String(req.params.id ?? ""));
  if (!row) return notFound(res);

  const current = presentSharedPage(row);
  if (current.visibility === "public") {
    res.status(200).json({ page: current });
    return;
  }
  if (!(await deckToolEnabled(auth.tenant_id))) {
    res.status(403).json({
      error: {
        code: "public_links_disabled",
        message: "Public links are turned off for this workspace, so this page can't be made public.",
      },
    });
    return;
  }

  const html = await readSharedPageHtml(auth.tenant_id, row.storage_path);
  if (html === null) return notFound(res);
  let scan: ReturnType<typeof scanArtifactForLeaks>;
  try {
    scan = scanArtifactForLeaks(`${row.title}\n${html}`);
  } catch {
    scan = { ok: false, reason: "scan_error" };
  }
  if (!scan.ok) {
    res.status(422).json({
      error: {
        code: "leak_blocked",
        message: "This page contains something that looks like a key or token, so it can't be made public.",
      },
    });
    return;
  }

  const expires_at = new Date(Date.now() + SHARED_PAGE_TTL_DAYS * 86_400_000).toISOString();
  const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
    .from("shared_pages")
    .update({
      status: "public",
      slug: generateSlug(),
      expires_at,
      published_at: new Date().toISOString(),
      revoked_at: null,
    })
    .eq("id", row.id)
    .select(SHARED_PAGE_FIELDS)
    .single<SharedPageRow>();
  if (error || !data) {
    res.status(500).json({ error: { code: "publish_failed", message: error?.message ?? "no row" } });
    return;
  }
  res.status(200).json({ page: presentSharedPage(data) });
}

export async function revokeSharedPage(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const row = await readOwnedPage(auth.tenant_id, String(req.params.id ?? ""));
  if (!row) return notFound(res);
  const { data, error } = await tenantClient(asTenantId(auth.tenant_id))
    .from("shared_pages")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", row.id)
    .select(SHARED_PAGE_FIELDS)
    .single<SharedPageRow>();
  if (error || !data) {
    res.status(500).json({ error: { code: "revoke_failed", message: error?.message ?? "no row" } });
    return;
  }
  res.status(200).json({ page: presentSharedPage(data) });
}

export async function shareReport(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const artifactId = String((req.body as { artifact_id?: unknown } | undefined)?.artifact_id ?? "");
  if (!UUID_RE.test(artifactId)) {
    res.status(400).json({ error: { code: "bad_artifact_id", message: "artifact_id must be a uuid." } });
    return;
  }
  const tid = asTenantId(auth.tenant_id);
  const db = tenantClient(tid);

  const { data: art, error: artErr } = await db
    .from("run_artifacts")
    .select("id, run_id, bucket, storage_path, mime, created_at")
    .eq("id", artifactId)
    .maybeSingle<{ id: string; run_id: string; bucket: string; storage_path: string; mime: string; created_at: string }>();
  if (artErr) {
    res.status(500).json({ error: { code: "read_failed", message: artErr.message } });
    return;
  }
  if (!art || art.mime !== UI_BLOCK_MIME) return notFound(res);
  if (!isSignableArtifactBucket(art.bucket) || !isTenantArtifactPath(auth.tenant_id, art.storage_path)) {
    return notFound(res);
  }

  const { data: blob, error: dlErr } = await tenantStorage(tid).from(art.bucket).download(art.storage_path);
  if (dlErr || !blob) return notFound(res);
  let block: UiBlock | null = null;
  try {
    block = parseUiBlock(JSON.parse(await blob.text()));
  } catch {
    block = null;
  }
  if (!block) return notFound(res);

  type Msg = { body: string | null; created_at: string; meta: Record<string, unknown> | null };
  const own = await db
    .from("agent_thread_messages")
    .select("body, created_at, meta")
    .eq("agent_run_id", art.run_id)
    .eq("sender_role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Msg>();
  let msg = own.data;
  let msgErr = own.error;
  if (!msg && !msgErr) {
    const parent = await db
      .from("agent_thread_messages")
      .select("body, created_at, meta")
      .eq("sender_role", "assistant")
      .contains("meta", { child_run_ids: [art.run_id] })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<Msg>();
    msg = parent.data;
    msgErr = parent.error;
  }
  if (msgErr) {
    res.status(500).json({ error: { code: "read_failed", message: msgErr.message } });
    return;
  }
  if (!msg) {
    res.status(422).json({ error: { code: "no_reply", message: "This report's reply could not be found, so it can't be shared yet." } });
    return;
  }
  const meta = msg.meta ?? {};
  const full =
    meta.overflow_scrubbed === true && typeof meta.full_reply_markdown === "string" && meta.full_reply_markdown.length > 0
      ? meta.full_reply_markdown
      : null;
  const { body: summary, sources } = splitSources(full ?? msg.body ?? "");

  const { data: tenant } = await db.from("tenants").select("display_name").maybeSingle<{ display_name: string | null }>();
  const page = renderReportPage({
    block,
    summary,
    sources,
    createdAt: msg?.created_at ?? art.created_at,
    artifactId: art.id,
    company: tenant?.display_name ?? null,
  });
  if (!page) {
    res.status(422).json({ error: { code: "not_a_report", message: "This card can't be shared as a report." } });
    return;
  }

  const { data: candidates } = await db
    .from("shared_pages")
    .select(SHARED_PAGE_FIELDS)
    .eq("run_id", art.run_id)
    .eq("title", page.title)
    .order("created_at", { ascending: false })
    .limit(10);
  for (const row of (candidates ?? []) as SharedPageRow[]) {
    const html = await readSharedPageHtml(auth.tenant_id, row.storage_path);
    if (html?.includes(reportMarker(art.id))) {
      res.status(200).json({ page: presentSharedPage(row) });
      return;
    }
  }

  try {
    const row = await createSharedPage({ tenant_id: auth.tenant_id, run_id: art.run_id, title: page.title, html: page.html });
    res.status(200).json({ page: presentSharedPage(row) });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "save_failed";
    res.status(code === "leak_blocked" ? 422 : 500).json({ error: { code, message: (e as Error).message } });
  }
}
