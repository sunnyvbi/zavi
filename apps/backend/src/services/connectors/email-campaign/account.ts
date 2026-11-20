
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { composioExecuteTool, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import type { SealedCredential } from "./credential";
import { EMAIL_TOOL_LABEL, EMAIL_TOOLS, type ComposioEmailTool, type EmailTool, type ProviderCall } from "./providers";
import { sendgridHttpCall } from "./providers-sendgrid";
import { resolveSendgridAccount, type SendgridAccount } from "./sendgrid-account";

export type EmailToolAccount =
  | { tool: ComposioEmailTool; account: OwnedComposioAccount }
  | { tool: "sendgrid"; sendgrid: SendgridAccount };

export type AccountDeps = {
  resolveAccount: typeof resolveOwnedComposioAccount;
  resolveSendgrid: typeof resolveSendgridAccount;
};

const DEFAULT_ACCOUNT_DEPS: AccountDeps = { resolveAccount: resolveOwnedComposioAccount, resolveSendgrid: resolveSendgridAccount };

async function resolveOne(tenantId: string, tool: EmailTool, deps: AccountDeps): Promise<EmailToolAccount | null> {
  if (tool === "sendgrid") {
    const sendgrid = await deps.resolveSendgrid(tenantId);
    return sendgrid ? { tool, sendgrid } : null;
  }
  const account = await deps.resolveAccount(tenantId, tool);
  return account ? { tool, account } : null;
}

export async function resolveEmailTool(
  tenantId: string,
  tool: EmailTool | undefined,
  depsIn: Partial<AccountDeps> = {},
): Promise<EmailToolAccount> {
  const deps = { ...DEFAULT_ACCOUNT_DEPS, ...depsIn };
  if (tool) {
    const resolved = await resolveOne(tenantId, tool, deps);
    if (!resolved) {
      throw new ExpectedToolError(
        "email_tool_not_connected",
        tool === "sendgrid"
          ? "SendGrid is not connected for campaigns in this workspace (no key, or the key lacks a campaign permission). The founder can connect it on the Connectors page. Until then, write the email as a draft for them to paste."
          : `${EMAIL_TOOL_LABEL[tool]} is not connected for this workspace. The founder can connect it on the Email campaigns channel. Until then, write the email as a draft for them to paste.`,
      );
    }
    return resolved;
  }
  const connected: EmailToolAccount[] = [];
  for (const t of EMAIL_TOOLS) {
    const resolved = await resolveOne(tenantId, t, deps);
    if (resolved) connected.push(resolved);
  }
  if (connected.length === 0) {
    throw new ExpectedToolError(
      "email_tool_not_connected",
      "No email tool is connected for this workspace. The founder can connect Mailchimp, Klaviyo or SendGrid. Until then, write the email as a draft for them to paste.",
    );
  }
  if (connected.length > 1) {
    throw new ExpectedToolError(
      "email_tool_ambiguous",
      `${connected.map((c) => EMAIL_TOOL_LABEL[c.tool]).join(" and ")} are connected. Say which one with tool: ${connected.map((c) => `"${c.tool}"`).join(" or ")}.`,
    );
  }
  return connected[0];
}

export async function connectedEmailTools(
  tenantId: string,
  depsIn: Partial<AccountDeps> = {},
): Promise<{ connected: EmailToolAccount[]; failed: Array<{ tool: EmailTool; error: unknown }> }> {
  const deps = { ...DEFAULT_ACCOUNT_DEPS, ...depsIn };
  const settled = await Promise.allSettled(EMAIL_TOOLS.map((t) => resolveOne(tenantId, t, deps)));
  const connected: EmailToolAccount[] = [];
  const failed: Array<{ tool: EmailTool; error: unknown }> = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") failed.push({ tool: EMAIL_TOOLS[i], error: r.reason });
    else if (r.value) connected.push(r.value);
  });
  return { connected, failed };
}

export async function soleEmailTool(tenantId: string, depsIn: Partial<AccountDeps> = {}): Promise<EmailTool | null> {
  try {
    return (await resolveEmailTool(tenantId, undefined, depsIn)).tool;
  } catch (e) {
    if (e instanceof ExpectedToolError) return null;
    throw e;
  }
}

export function credentialFor(a: EmailToolAccount): SealedCredential {
  return a.tool === "sendgrid"
    ? { kind: "sendgrid_key", key_digest: a.sendgrid.key_digest }
    : { kind: "composio", connected_account_id: a.account.connected_account_id, auth_config_id: a.account.auth_config_id };
}

export function accountCall(
  a: EmailToolAccount,
  exec: typeof composioExecuteTool = composioExecuteTool,
  fetchImpl: typeof fetch = fetch,
): ProviderCall {
  if (a.tool === "sendgrid") return sendgridHttpCall(a.sendgrid.api_key, fetchImpl);
  const account = a.account;
  return (tool_slug, args) =>
    exec({ tool_slug, user_id: account.tenant_id, connected_account_id: account.connected_account_id, arguments: args });
}
