
import { randomBytes } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import type { HtmlPreview } from "@/agents/engineer/output-schema";
import { githubTokenRegex } from "@/services/security/github-token-pattern";

export async function shareablePreviewEnabled(
  tenant_id: string | null | undefined,
): Promise<boolean> {
  if (!tenant_id) return false;
  try {
    return await getBoolSetting("engineer_shareable_preview_enabled", tenant_id);
  } catch {
    return false;
  }
}

export async function wireframeToolEnabled(
  tenant_id: string | null | undefined,
): Promise<boolean> {
  if (!tenant_id) return false;
  return getBoolSetting("agent_wireframe_enabled", tenant_id);
}

export async function deckToolEnabled(
  tenant_id: string | null | undefined,
): Promise<boolean> {
  if (!tenant_id) return false;
  return getBoolSetting("agent_deck_enabled", tenant_id);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateSlug(bytes: Buffer = randomBytes(16)): string {
  let out = "";
  let n = BigInt(`0x${bytes.toString("hex")}`);
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(22, "0");
}

export const SLUG_RE = /^[0-9A-Za-z]{20,24}$/;

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "stripe_key", re: /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", re: githubTokenRegex() },
  { name: "slack_token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "private_key_pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", re: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/ },
  {
    name: "env_secret_pair",
    re: /\b[A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|SERVICE_ROLE)[A-Z0-9_]*\s*[=:]\s*(?:\\?["'])?[^\s"'\\]{12,}/,
  },
];

export type LeakScanResult =
  | { ok: true }
  | { ok: false; reason: string };

export function scanArtifactForLeaks(serialized: string): LeakScanResult {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(serialized)) return { ok: false, reason: p.name };
  }
  return { ok: true };
}

export function prototypeLinkBaseUrl(): string {
  return (process.env.PROTOTYPE_LINK_BASE_URL || "https://preview.zaviagent.com").replace(/\/+$/, "");
}

export const PROTOTYPE_BUCKET = "prototype-links";

export type PublishResult =
  | { published: true; slug: string; url: string }
  | { published: false; reason: "disabled" | "blocked" | "error"; detail?: string };

export async function publishPrototypeLink(opts: {
  tenant_id: string;
  run_id: string;
  envelope: HtmlPreview;
}): Promise<PublishResult> {
  try {
    if (!(await shareablePreviewEnabled(opts.tenant_id))) {
      return { published: false, reason: "disabled" };
    }

    const serialized = JSON.stringify(opts.envelope);
    const scan = scanArtifactForLeaks(serialized);
    if (!scan.ok) {
      try {
        await serviceClient().rpc("create_prototype_link", {
          p_run_id: opts.run_id,
          p_slug: generateSlug(),
          p_artifact_path: "",
          p_status: "blocked",
        });
      } catch {
      }
      console.warn(
        `[prototype-link] leak-scan BLOCKED publish for run=${opts.run_id} (${scan.reason})`,
      );
      return { published: false, reason: "blocked", detail: scan.reason };
    }

    const sb = serviceClient();
    const slug = generateSlug();

    const { data: row, error: rpcErr } = await sb.rpc("create_prototype_link", {
      p_run_id: opts.run_id,
      p_slug: slug,
      p_artifact_path: "pending",
    });
    if (rpcErr || !row) {
      return { published: false, reason: "error", detail: rpcErr?.message ?? "rpc_null" };
    }
    const linkRow = row as { id: string; slug: string };

    const artifactPath = `${linkRow.id}/envelope.json`;
    const { error: upErr } = await sb.storage
      .from(PROTOTYPE_BUCKET)
      .upload(artifactPath, Buffer.from(serialized, "utf8"), {
        contentType: "application/json",
        upsert: true,
      });
    if (upErr) {
      return { published: false, reason: "error", detail: upErr.message };
    }

    const { error: pathErr } = await sb.rpc("create_prototype_link", {
      p_run_id: opts.run_id,
      p_slug: linkRow.slug,
      p_artifact_path: artifactPath,
    });
    if (pathErr) {
      return { published: false, reason: "error", detail: pathErr.message };
    }

    const url = `${prototypeLinkBaseUrl()}/${linkRow.slug}`;
    console.log(`[prototype-link] published run=${opts.run_id} → ${url}`);
    return { published: true, slug: linkRow.slug, url };
  } catch (e) {
    return { published: false, reason: "error", detail: (e as Error).message };
  }
}

async function publishVariantLink(opts: {
  tenant_id: string;
  run_id: string;
  envelope: HtmlPreview;
  variant: "wireframe" | "deck" | "doc";
  enabled: (tenant_id: string) => Promise<boolean>;
  logTag: string;
}): Promise<PublishResult> {
  try {
    if (!(await opts.enabled(opts.tenant_id))) {
      return { published: false, reason: "disabled" };
    }

    const envelope: HtmlPreview = { ...opts.envelope, variant: opts.variant };

    const serialized = JSON.stringify(envelope);
    const scan = scanArtifactForLeaks(serialized);
    if (!scan.ok) {
      try {
        await serviceClient().rpc("create_prototype_link", {
          p_run_id: opts.run_id,
          p_slug: generateSlug(),
          p_artifact_path: "",
          p_status: "blocked",
        });
      } catch {
      }
      console.warn(
        `[${opts.logTag}] leak-scan BLOCKED publish for run=${opts.run_id} (${scan.reason})`,
      );
      return { published: false, reason: "blocked", detail: scan.reason };
    }

    const sb = serviceClient();
    const slug = generateSlug();

    const { data: row, error: rpcErr } = await sb.rpc("create_prototype_link", {
      p_run_id: opts.run_id,
      p_slug: slug,
      p_artifact_path: "pending",
    });
    if (rpcErr || !row) {
      return { published: false, reason: "error", detail: rpcErr?.message ?? "rpc_null" };
    }
    const linkRow = row as { id: string; slug: string };

    const artifactPath = `${linkRow.id}/envelope.json`;
    const { error: upErr } = await sb.storage
      .from(PROTOTYPE_BUCKET)
      .upload(artifactPath, Buffer.from(serialized, "utf8"), {
        contentType: "application/json",
        upsert: true,
      });
    if (upErr) {
      return { published: false, reason: "error", detail: upErr.message };
    }

    const { error: pathErr } = await sb.rpc("create_prototype_link", {
      p_run_id: opts.run_id,
      p_slug: linkRow.slug,
      p_artifact_path: artifactPath,
    });
    if (pathErr) {
      return { published: false, reason: "error", detail: pathErr.message };
    }

    const url = `${prototypeLinkBaseUrl()}/${linkRow.slug}`;
    console.log(`[${opts.logTag}] published run=${opts.run_id} → ${url}`);
    return { published: true, slug: linkRow.slug, url };
  } catch (e) {
    return { published: false, reason: "error", detail: (e as Error).message };
  }
}

export async function publishWireframeLink(opts: {
  tenant_id: string;
  run_id: string;
  envelope: HtmlPreview;
}): Promise<PublishResult> {
  return publishVariantLink({
    ...opts,
    variant: "wireframe",
    enabled: wireframeToolEnabled,
    logTag: "wireframe-link",
  });
}

export async function publishDocLink(opts: {
  tenant_id: string;
  run_id: string;
  title: string;
  summary: string;
  html: string;
}): Promise<PublishResult> {
  return publishVariantLink({
    tenant_id: opts.tenant_id,
    run_id: opts.run_id,
    envelope: {
      kind: "html_preview",
      variant: "doc",
      title: opts.title,
      summary: opts.summary,
      html: opts.html,
    },
    variant: "doc",
    enabled: deckToolEnabled,
    logTag: "doc-link",
  });
}

export async function publishDeckLink(opts: {
  tenant_id: string;
  run_id: string;
  title: string;
  summary: string;
  html: string;
}): Promise<PublishResult> {
  return publishVariantLink({
    tenant_id: opts.tenant_id,
    run_id: opts.run_id,
    envelope: {
      kind: "html_preview",
      variant: "deck",
      title: opts.title,
      summary: opts.summary,
      html: opts.html,
    },
    variant: "deck",
    enabled: deckToolEnabled,
    logTag: "deck-link",
  });
}
