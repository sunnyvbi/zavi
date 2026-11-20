
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Request, Response } from "express";
import { serviceClient } from "@/services/supabase";
import { makeBindCode } from "@/services/connectors/bind-code";
import { ON_IT_ACK } from "@/services/connectors/chat-copy";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import {
  teamsEnabled,
  getTeamsAdapter,
  getConversationReference,
} from "@/services/connectors/teams/adapter";
import { postTeamsReply } from "@/services/tools/teams/_client";
import { sanitizeTeamsActivityPayload } from "@/services/redactor/teams-payload-sanitizer";
import { stripBotMention } from "@/services/connectors/teams/mention";
import {
  classifyTeamsText,
  connectedReplyFor,
  TEAMS_HELP_TEXT,
  TEAMS_NOT_CONNECTED_TEXT,
  teamsInstallWelcomeText,
} from "@/services/connectors/teams/commands";

function m365TenantIdOf(activity: any): string {
  return String(
    activity?.channelData?.tenant?.id ??
      activity?.conversation?.tenantId ??
      "",
  );
}

async function resolveTenant(m365TenantId: string): Promise<string | null> {
  if (!m365TenantId) return null;
  const svc = serviceClient();
  const { data, error } = await svc
    .from("teams_tenants")
    .select("tenant_id, status")
    .eq("m365_tenant_id", m365TenantId)
    .maybeSingle<{ tenant_id: string; status: string }>();
  if (error || !data || data.status !== "enabled") return null;
  return data.tenant_id;
}

async function handleInstall(activity: any): Promise<void> {
  const m365 = m365TenantIdOf(activity);
  if (!m365) return;
  const ref = await getConversationReference(activity);
  const svc = serviceClient();

  const tenantId = await resolveTenant(m365);
  if (tenantId) {
    await svc.rpc("set_teams_connection", {
      p_tenant_id: tenantId,
      p_m365_tenant_id: m365,
      p_service_url: String(activity?.serviceUrl ?? ""),
      p_install_conversation_reference: ref,
    });
    await postTeamsReply({ conversationReference: ref, text: TEAMS_HELP_TEXT }).catch(() => {});
    return;
  }

  const bindCode = makeBindCode();
  const { error: pendErr } = await svc.rpc("create_teams_pending_binding", {
    p_m365_tenant_id: m365,
    p_service_url: String(activity?.serviceUrl ?? ""),
    p_install_conversation_reference: ref,
    p_bind_code: bindCode,
    p_ttl_seconds: 900,
  });
  if (pendErr) {
    console.warn("[webhooks/teams] create_teams_pending_binding failed:", pendErr.message);
    return;
  }
  const connectUrl =
    `https://www.zaviagent.com/workspace?tab=settings&teams_bind=${encodeURIComponent(bindCode)}`;
  await postTeamsReply({
    conversationReference: ref,
    text: teamsInstallWelcomeText(connectUrl, bindCode),
  }).catch(() => {});
}

async function handleMessage(activity: any): Promise<void> {
  const m365 = m365TenantIdOf(activity);
  const tenantId = await resolveTenant(m365);
  if (!tenantId) {
    const ref = await getConversationReference(activity);
    void postTeamsReply({ conversationReference: ref, text: TEAMS_NOT_CONNECTED_TEXT }).catch(
      () => {},
    );
    return;
  }

  const svc = serviceClient();
  const eventId = String(activity?.id ?? "");
  if (!eventId) return;

  const sanitized = sanitizeTeamsActivityPayload(activity) as Record<string, unknown>;

  const { data: ingestId, error: ingestErr } = await svc.rpc("ingest_event", {
    p_tenant_id: tenantId,
    p_provider: "teams",
    p_external_event_id: eventId,
    p_event_type: String(activity?.type ?? "message"),
    p_payload: sanitized,
  });
  if (ingestErr || !ingestId) return;

  const sanitizedText =
    typeof (sanitized as any)?.text === "string" ? (sanitized as any).text : "";
  const command = classifyTeamsText(
    stripBotMention(sanitizedText, (activity as any)?.entities),
  );

  const ref = await getConversationReference(activity);

  const builtIn = connectedReplyFor(command);
  if (builtIn) {
    void postTeamsReply({ conversationReference: ref, text: builtIn }).catch(() => {});
    return;
  }
  const taskText = command.kind === "task" ? command.text : "";

  void postTeamsReply({
    conversationReference: ref,
    text: ON_IT_ACK,
    aiGenerated: true,
  }).catch(() => {});

  await enqueueWorkItem({
    tenant_id: tenantId,
    agent_slug: "operator",
    source: "webhook_teams",
    dedupe_key: `teams:${eventId}`,
    payload: {
      ingested_event_id: ingestId as string,
      event_type: String(activity?.type ?? "message"),
      teams: {
        conversation_reference: ref,
        conversation_id: String(activity?.conversation?.id ?? ""),
        service_url: String(activity?.serviceUrl ?? ""),
        activity_id: eventId,
        m365_tenant_id: m365,
        text: taskText,
      },
    },
  });
}

export async function teamsWebhook(req: Request, res: Response): Promise<void> {
  if (!teamsEnabled()) {
    res.status(503).json({
      error: {
        code: "teams_disabled",
        message: "Teams connector not configured (MICROSOFT_APP_ID unset).",
      },
    });
    return;
  }

  let adapter: any;
  try {
    adapter = await getTeamsAdapter();
  } catch (e) {
    console.warn(
      `[webhooks/teams] adapter init failed (botbuilder import/config): ${(e as Error).message}`,
    );
    res.status(503).json({ error: { code: "teams_adapter_init_failed" } });
    return;
  }
  if (!adapter) {
    res.status(503).json({
      error: { code: "teams_disabled", message: "Teams adapter unavailable." },
    });
    return;
  }

  try {
    await adapter.process(req, res, async (context: any) => {
      try {
        const activity = context.activity;
        if (activity?.type === "message") {
          await handleMessage(activity);
        } else if (activity?.type === "conversationUpdate") {
          const added = Array.isArray(activity?.membersAdded)
            ? activity.membersAdded
            : [];
          const botId = activity?.recipient?.id;
          if (added.some((m: any) => m?.id === botId)) {
            await handleInstall(activity);
          }
        }
      } catch (e) {
        console.warn(
          `[webhooks/teams] turn handler error (acking): ${(e as Error).message}`,
        );
      }
    });
  } catch (e) {
    console.warn(
      `[webhooks/teams] adapter.process failed: ${(e as Error).message}`,
    );
    if (!res.headersSent) {
      res.status(401).json({ error: { code: "teams_auth_failed" } });
    }
  }
}
