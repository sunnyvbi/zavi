
import { z } from "zod";
import { UI_BLOCK_MIME, UiBlockSchema, type UiBlock } from "@zavi/shared";
import { resolveChartInput, resolveKpiInput, type ChartInput, type KpiInput } from "./ui-block-refs";
import type { AnyZodRawShape } from "@anthropic-ai/claude-agent-sdk";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import { ARTIFACT_BUCKET } from "@/services/reports/constants";
import { sanitizePreviewHtml } from "@/services/agents/html-preview-artifacts";
import { getBoolSetting } from "@/services/settings";
import { recordShownRows, resetShownRows } from "@/services/agents/engine/figure-ledger";
import { htmlRendersBlank, SHOW_TOOLS, UI_TOOL_HALT_MESSAGE, type ShowToolName, type UiToolDecl } from "./ui-tools";
import { CHAT_CARDS_MAX, GROWTH_LINK, NEEDS_YOU_LINK, UnknownChannelError, chatCardsReply, pickChatCards, type ChatCard } from "@/services/approvals/chat-cards";
import { attachCardToChat } from "@/services/approvals/chat-card-attach";

export async function htmlCardScriptsEnabled(tenantId: string): Promise<boolean> {
  if (process.env.ZAVI_HTML_CARD_SCRIPTS === "1") return true;
  return getBoolSetting("html_card_scripts_enabled", tenantId).catch(() => false);
}

export type UiToolsCtx = {
  tenant_id: string;
  run_id: string;
  agent_slug: string;
  frontend_tools: UiToolDecl[];
  approval_cards?: boolean;
  actor_user_id?: string | null;
};

async function askerRole(ctx: UiToolsCtx): Promise<string | null> {
  if (!ctx.actor_user_id) return null;
  try {
    const { data, error } = await tenantClient(asTenantId(ctx.tenant_id)).from("tenant_users").select("role").eq("user_id", ctx.actor_user_id).maybeSingle();
    return error ? null : ((data as { role?: string } | null)?.role ?? null);
  } catch {
    return null;
  }
}

export const SHOW_APPROVAL_CARDS = "show_approval_cards";

const showApprovalCardsSchema = z.object({
  decision_ids: z.array(z.string().max(64)).max(CHAT_CARDS_MAX).optional(),
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).optional(),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const UI_BLOCK_FALLBACK_CONTENT_TYPE = "text/csv";

export async function saveUiBlockArtifact(
  ctx: Pick<UiToolsCtx, "tenant_id" | "run_id" | "agent_slug">,
  seq: number,
  block: UiBlock,
): Promise<string> {
  const tid = asTenantId(ctx.tenant_id);
  const filename = `ui-block-${seq}.json`;
  const storagePath = `${tid}/${ctx.run_id}/${filename}`;
  const bytes = Buffer.from(JSON.stringify(block), "utf8");
  const storage = tenantStorage(tid).from(ARTIFACT_BUCKET);
  let { error: upErr } = await storage.upload(storagePath, bytes, { contentType: UI_BLOCK_MIME, upsert: true });
  if (upErr && /mime type/i.test(upErr.message)) {
    ({ error: upErr } = await storage.upload(storagePath, bytes, { contentType: UI_BLOCK_FALLBACK_CONTENT_TYPE, upsert: true }));
  }
  if (upErr) throw new Error(`ui block upload failed: ${upErr.message}`);
  const { data, error } = await tenantClient(tid)
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: tid,
        run_id: ctx.run_id,
        storage_path: storagePath,
        bucket: ARTIFACT_BUCKET,
        filename,
        title: block.title,
        mime: UI_BLOCK_MIME,
        bytes: bytes.byteLength,
        agent_slug: ctx.agent_slug,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single<{ id: string }>();
  if (error || !data?.id) throw new Error(`ui block row failed: ${error?.message ?? "no id"}`);
  trackDocumentDelivered({ tenant_id: tid, mime: UI_BLOCK_MIME });
  return data.id;
}

function shapeFromJsonSchema(schema: Record<string, unknown>): AnyZodRawShape {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const k of Object.keys(props)) shape[k] = z.unknown().optional();
  if (Object.keys(shape).length === 0) shape.input = z.unknown().optional();
  return shape as AnyZodRawShape;
}

function allNumbers(s: string): string[] {
  const noSpans = s.replace(/\b\d[\d,]*(?:\.\d+)?\s*-?\s*(?:days?|weeks?|months?|years?|yrs?|hours?|hrs?|minutes?|mins?)\b/gi, " ");
  return (noSpans.match(/[-+]?\$?\d[\d,]*(?:\.\d+)?%?(?![\w.])/g) ?? []).filter((t) => {
    if (/[%$]/.test(t)) return true;
    const d = t.replace(/[^0-9]/g, "");
    return d.length >= 3 && !/^(19|20)\d\d$/.test(d);
  });
}

export function shownRowsOf(block: UiBlock): string[][] {
  const str = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? v : "");
  switch (block.kind) {
    case "table":
      return [...block.rows.map((r) => r.map(str)), ...(block.note ? [allNumbers(block.note)] : [])];
    case "chart":
      return [...block.series, ...(block.compare ?? [])].map((p) => [str(p.value)]);
    case "kpi":
      return block.items.map((i) => [str(i.value), ...allNumbers(str(i.delta))]);
    default:
      return [];
  }
}

export async function mcpUiTools(ctx: UiToolsCtx) {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const tools: unknown[] = [];
  let seq = 0;
  resetShownRows(ctx.run_id);

  for (const decl of ctx.frontend_tools) {
    tools.push(tool(decl.name, decl.description, shapeFromJsonSchema(decl.parameters), async () => text(UI_TOOL_HALT_MESSAGE)));
  }

  for (const name of Object.keys(SHOW_TOOLS) as ShowToolName[]) {
    const def = SHOW_TOOLS[name];
    tools.push(
      tool(name, def.description, def.schema.shape as unknown as AnyZodRawShape, async (args) => {
        const parsed = def.schema.safeParse(args);
        if (!parsed.success) {
          const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400);
          return { ...text(`Block rejected — fix and retry: ${msg}`), isError: true };
        }
        let block = { kind: def.kind, ...parsed.data } as UiBlock;
        if (def.kind === "chart" || def.kind === "kpi") {
          const r =
            def.kind === "chart"
              ? resolveChartInput(ctx, parsed.data as ChartInput)
              : resolveKpiInput(ctx, parsed.data as KpiInput);
          if (!r.ok) return { ...text(`Block rejected: ${r.message}`), isError: true };
          const checked = UiBlockSchema.safeParse(r.block);
          if (!checked.success) {
            const msg = checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400);
            return { ...text(`Block rejected: fix and retry: ${msg}`), isError: true };
          }
          block = checked.data;
        }
        if (block.kind === "html") {
          const scripts = await htmlCardScriptsEnabled(ctx.tenant_id);
          const safe = sanitizePreviewHtml(block.html, { allowScripts: scripts });
          if (!safe.ok) {
            return {
              ...text(
                `HTML rejected (${safe.reason}) — keep it self-contained, under 200KB, no frames/forms/external resources${scripts ? ", and no location/window.open/top/parent in scripts" : ""}; retry.`,
              ),
              isError: true,
            };
          }
          if (!scripts && htmlRendersBlank(safe.html)) {
            return {
              ...text(
                "HTML rejected — its <svg>/<canvas> is empty and scripts are off in this workspace, " +
                  "so this card would render as a blank box. For a chart use show_chart (it takes `colors`); " +
                  "for anything else draw the shapes inline as SVG instead of scripting them.",
              ),
              isError: true,
            };
          }
          block = { ...block, html: safe.html, ...(scripts ? { scripts: true } : {}) };
        }
        try {
          seq += 1;
          await saveUiBlockArtifact(ctx, seq, block);
          recordShownRows(ctx.run_id, shownRowsOf(block));
          const base =
            `Rendered "${block.title}" as a ${def.kind} card under your reply. ` +
            "Keep the reply short: open with one sentence that answers the question with its key number, " +
            "then at most two short lines on what it means. Do not repeat the card's data in prose.";
          return text(
            def.kind === "chart"
              ? `${base} If the user then asks to restyle or recolour it — "make negatives red", "use green", "colour by sign" — call show_chart AGAIN with the same title and the SAME series plus \`colors\`. Never redraw this chart as HTML: you would lose the workspace theme and duplicate the title.`
              : base,
          );
        } catch (e) {
          return { ...text(`Couldn't render the ${def.kind} card (${(e as Error).message}). Answer in text instead.`), isError: true };
        }
      }),
    );
  }

  if (ctx.approval_cards) {
    tools.push(
      tool(
        SHOW_APPROVAL_CARDS,
        "Put live approval cards under your reply so the founder approves or rejects right in this chat. " +
          "Call it when the founder asks what needs their approval or what is waiting, or when you recommend approving a waiting card. " +
          `No decision_ids: shows the ${CHAT_CARDS_MAX} most important waiting cards (growth first, then oldest). ` +
          "decision_ids: exactly those cards (the one you recommend; ids come from query_pending_decisions or an earlier show_approval_cards result). channel: only that channel's cards when the founder asks about one channel (e.g. google_ads). " +
          "Never tell the founder they cannot approve from chat.",
        showApprovalCardsSchema.shape as unknown as AnyZodRawShape,
        async (args) => {
          const parsed = showApprovalCardsSchema.safeParse(args);
          if (!parsed.success) return { ...text("Rejected: decision_ids must be up to 5 ids; channel a channel slug."), isError: true };
          try {
            const [pick, role] = await Promise.all([pickChatCards(tenantClient(asTenantId(ctx.tenant_id)), parsed.data), askerRole(ctx)]);
            const shown: ChatCard[] = [];
            const refused: string[] = [];
            const failed: string[] = [];
            for (const c of pick.cards) {
              try {
                const r = await attachCardToChat({ tenant_id: ctx.tenant_id, run_id: ctx.run_id, card_id: c.id, table: "decisions", bringToLatest: true });
                if (!r.shown && r.reason === "not_chat") {
                  return text(`This turn is not a founder chat, so no card can be shown here. ${pick.cards.length} card(s) still wait: say where, [Needs you](${NEEDS_YOU_LINK}) or the [Growth page](${GROWTH_LINK}).`);
                }
                if (r.shown) shown.push(c);
                else refused.push(c.id);
              } catch {
                failed.push(c.id);
              }
            }
            let reply = chatCardsReply({ ...pick, cards: shown, not_shown: [...pick.not_shown, ...refused] }, role);
            if (failed.length > 0) reply += `\nCould not show ${failed.join(", ")} just now. Call show_approval_cards once more with those ids; if it fails again, link [Needs you](${NEEDS_YOU_LINK}).`;
            return shown.length === 0 && failed.length > 0 ? { ...text(reply), isError: true } : text(reply);
          } catch (e) {
            if (e instanceof UnknownChannelError) {
              return { ...text(`Rejected: ${e.message} is not a channel slug. Use one like google_ads or meta_ads, or leave channel out.`), isError: true };
            }
            return { ...text(`Couldn't show the cards (${(e as Error).message}). Point the founder to Needs you instead.`), isError: true };
          }
        },
        { alwaysLoad: true },
      ),
    );
  }

  return createSdkMcpServer({ name: "ui", version: "0.1.0", tools: tools as never });
}
