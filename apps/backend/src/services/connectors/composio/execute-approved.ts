import { z } from "zod";
import { resolveOwnedComposioAccount } from "./account";
import { composioExecuteTool } from "./api";
import { listToolkitToolSlugs } from "./catalog";
import { classifyComposioWrite } from "./write-classify";
import { composioWriteFingerprint } from "./fingerprint";
import { logEvent } from "@/services/logging/logEvent";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { isRawEmailSendAction, RAW_EMAIL_SEND_MESSAGE } from "@/services/connectors/email-campaign/providers";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { isTiktokSpendWrite, TIKTOK_RAW_WRITE_MESSAGE } from "@/services/connectors/tiktok-ads/held-schema";
import { isRawPinterestWrite, PINTEREST_RAW_WRITE_MESSAGE } from "@/services/connectors/pinterest-composio/raw-write";
import { executeApprovedShopifyProductUpdate } from "@/services/connectors/shopify/execute-approved";
import {
  checkShopifyWrite,
  SHOPIFY_PRODUCTS_TOOL,
  SHOPIFY_PRODUCT_UPDATE_OPERATION,
} from "@/services/connectors/shopify/writes";

const bodySchema = z
  .object({
    kind: z.literal("composio_write"),
    tool_slug: z.string().regex(/^[A-Z0-9_]{3,120}$/),
    toolkit: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    app_name: z.string().min(1).max(80),
    arguments: z.record(z.string(), z.unknown()),
    classification: z.object({ destructive: z.boolean() }),
    labels: z.array(z.enum(["moves_money", "deletes_data"])),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    connected_account_id: z.string().min(1),
    auth_config_id: z.string().min(1),
  })
  .passthrough();

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

export async function executeApprovedComposioWrite(d: {
  id: string;
  tenant_id: string;
  decision_class: string;
  body: unknown;
  approved_by?: string | null;
  approved_by_source?: string | null;
}): Promise<{ ok: boolean; error?: string; notice?: string; agent_outcome?: string; outcome_unknown?: boolean }> {
  const p = bodySchema.safeParse(d.body);
  if (!p.success) return { ok: false, error: "composio_write body invalid" };
  const b = p.data;
  if (isRawEmailSendAction(b.tool_slug, b.toolkit)) {
    return { ok: false, error: `use_email_campaign_tool: ${RAW_EMAIL_SEND_MESSAGE}` };
  }
  if (isTiktokSpendWrite(b.tool_slug, b.toolkit)) {
    return { ok: false, error: `use_tiktok_ads_propose_tool: ${TIKTOK_RAW_WRITE_MESSAGE}` };
  }
  if (isRawPinterestWrite(b.tool_slug, b.toolkit)) {
    return { ok: false, error: `use_social_propose_post: ${PINTEREST_RAW_WRITE_MESSAGE}` };
  }
  if (composioWriteFingerprint({ ...b, decision_class: d.decision_class }) !== b.fingerprint) {
    return { ok: false, error: "composio_fingerprint_mismatch" };
  }
  let kitTools: ReadonlySet<string>;
  try {
    kitTools = await listToolkitToolSlugs(b.toolkit);
  } catch {
    return { ok: false, error: "composio_catalog_unavailable" };
  }
  if (!kitTools.has(b.tool_slug)) return { ok: false, error: "composio_tool_toolkit_mismatch" };
  if (b.toolkit === "shopify") {
    const shopify = checkShopifyWrite(b.tool_slug, b.arguments);
    if (!shopify.ok) return { ok: false, error: `shopify_write_not_allowed: ${shopify.message}` };
  }
  const fresh = classifyComposioWrite({ toolkit: b.toolkit, tool_slug: b.tool_slug, ...b.classification });
  if (d.decision_class !== fresh.decision_class || !sameSet(b.labels, fresh.labels)) {
    return { ok: false, error: "composio_class_mismatch" };
  }
  let account: Awaited<ReturnType<typeof resolveOwnedComposioAccount>>;
  try {
    account = await resolveOwnedComposioAccount(d.tenant_id, b.toolkit);
  } catch {
    return { ok: false, error: "composio_account_check_failed" };
  }
  if (!account) return { ok: false, error: `Reconnect ${b.app_name}, then approve again.` };
  if (account.connected_account_id !== b.connected_account_id || account.auth_config_id !== b.auth_config_id) {
    return { ok: false, error: `The connected ${b.app_name} account changed. Ask again so you can approve it for the new account.` };
  }
  if (b.labels.length && d.approved_by && d.approved_by_source !== "staff") {
    let role: string | null;
    try { role = await loadTenantRoleFor(d.approved_by, d.tenant_id); } catch { return { ok: false, error: "composio_approver_role_unavailable" }; }
    if (role !== "owner" && role !== "admin") return { ok: false, error: `The person who approved this no longer has owner or admin access, so Zavi did not run it in ${b.app_name}. Approve it again as an owner or admin.` };
  }
  await logEvent({
    level: "info",
    source: "composio.execute",
    code: "composio_write_started",
    tenant_id: d.tenant_id,
    meta: { tool_name: b.tool_slug, decision_class: d.decision_class },
  }).catch(() => {});
  const r = b.toolkit === "shopify" &&
      b.tool_slug === SHOPIFY_PRODUCTS_TOOL &&
      b.arguments.operation === SHOPIFY_PRODUCT_UPDATE_OPERATION
    ? await executeApprovedShopifyProductUpdate({ account, arguments: b.arguments })
    : await composioExecuteTool({
        tool_slug: b.tool_slug,
        user_id: account.tenant_id,
        connected_account_id: account.connected_account_id,
        arguments: b.arguments,
      });
  if (!r.ok && r.outcome_unknown) {
    return { ok: false, outcome_unknown: true, error: "composio_outcome_unknown" };
  }
  if (!r.ok) {
    const msg =
      typeof r.error === "string"
        ? r.error
        : ((r.error as { message?: string } | null)?.message ?? `HTTP ${r.status}`);
    return { ok: false, error: `${b.app_name} refused: ${msg}` };
  }
  const data = r.data == null ? "" : JSON.stringify(r.data);
  let n = 1400;
  let block = renderUntrustedBlock("tool_composio", data.slice(0, n));
  while (block.length > 1800 && n > 50) {
    n = Math.floor(n / 2);
    block = renderUntrustedBlock("tool_composio", data.slice(0, n));
  }
  return {
    ok: true,
    notice: `Done in ${b.app_name}.`,
    ...(data && data !== "{}" && block.length <= 1800 ? { agent_outcome: `${b.app_name} returned: ${block}` } : {}),
  };
}
