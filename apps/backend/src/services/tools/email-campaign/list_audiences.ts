
import { z } from "zod";
import { accountCall, connectedEmailTools, resolveEmailTool, type EmailToolAccount } from "@/services/connectors/email-campaign/account";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, EMAIL_TOOLS, EmailToolError, type Audience, type EmailTool } from "@/services/connectors/email-campaign/providers";
import { readTestListKeys, testListKey } from "@/services/email-cards/variants";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";

const inputSchema = z.object({
  tool: z.enum(EMAIL_TOOLS).optional().describe("Which email tool. Leave out to read every connected one."),
});

const MAX_PAGES = 20;

type ToolLists = { audiences: Audience[]; note?: string };

async function readLists(resolved: EmailToolAccount): Promise<ToolLists> {
  const label = EMAIL_TOOL_LABEL[resolved.tool];
  const call = accountCall(resolved);
  const audiences: Audience[] = [];
  let cursor: string | null = null;
  let partial: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      partial = `${label} has more lists than Zavi reads at once; these are the first ${audiences.length}.`;
      break;
    }
    const r = await EMAIL_PROVIDERS[resolved.tool].listAudiencesPage(call, cursor);
    audiences.push(...r.lists);
    if (!r.next) break;
    if (r.next === cursor) {
      partial = `${label} kept answering the same page, so this list may not be complete.`;
      break;
    }
    cursor = r.next;
  }
  return { audiences, note: partial ?? (audiences.length === 0 ? `${label} has no lists yet, so there is nobody to send to.` : undefined) };
}

async function readMarks(tenantId: string): Promise<ReadonlySet<string>> {
  const marks = await readTestListKeys(tenantId).catch(() => null);
  if (!marks) throw new ExpectedToolError("email_test_lists_unreadable", "Zavi could not check the founder's test lists, so it cannot say which lists are marked. Try again.");
  return marks;
}

async function readOneTool(tenantId: string, resolved: EmailToolAccount) {
  let lists: ToolLists;
  try {
    lists = await readLists(resolved);
  } catch (e) {
    if (e instanceof EmailToolError) {
      throw new ExpectedToolError("email_tool_read_failed", `${EMAIL_TOOL_LABEL[resolved.tool]} could not be read: ${e.message}`);
    }
    throw e;
  }
  const marks = await readMarks(tenantId);
  return {
    tool: resolved.tool,
    audiences: lists.audiences.map((a) => ({ id: a.id, name: a.name, member_count: a.member_count, marked_test: marks.has(testListKey(resolved.tool, a.id)) })),
    note: lists.note,
  };
}

function unreadableMessage(tool: EmailTool, e: unknown): string {
  const label = EMAIL_TOOL_LABEL[tool];
  if (e instanceof EmailToolError) return `${label} could not be read: ${e.message}`;
  console.warn(`[email_campaign_list_audiences] ${tool} read failed`, e instanceof Error ? e.message : String(e));
  return `${label} could not be read just now.`;
}

async function readEveryTool(tenantId: string, connected: EmailToolAccount[], failed: Array<{ tool: EmailTool; error: unknown }>) {
  const reads = await Promise.all(
    connected.map(async (resolved) => {
      try {
        return { tool: resolved.tool, lists: await readLists(resolved) };
      } catch (error) {
        return { tool: resolved.tool, error };
      }
    }),
  );
  const unreadable = [...failed, ...reads.flatMap((r) => ("error" in r ? [{ tool: r.tool, error: r.error }] : []))].map((f) => ({
    tool: f.tool,
    message: unreadableMessage(f.tool, f.error),
  }));
  const read = reads.flatMap((r) => (r.lists ? [{ tool: r.tool, ...r.lists }] : []));
  if (read.length === 0) {
    throw new ExpectedToolError("email_tool_read_failed", unreadable.map((u) => u.message).join(" "));
  }
  const marks = await readMarks(tenantId);
  return {
    unreadable,
    notes: read.flatMap((r) => (r.note ? [{ tool: r.tool, note: r.note }] : [])),
    audiences: read.flatMap((r) => r.audiences.map((a) => ({ tool: r.tool, id: a.id, name: a.name, member_count: a.member_count, marked_test: marks.has(testListKey(r.tool, a.id)) }))),
  };
}

export const emailCampaignListAudiencesTool: ToolSpec = {
  name: "email_campaign_list_audiences",
  effect: "read",
  description:
    "List the email lists in the founder's connected email tools (SendGrid, Mailchimp or Klaviyo): id, name and how many people are on each " +
    "(null when the tool does not report it in a list read), and marked_test: whether the founder marked it a test list (size never does), every page of them. Read-only. Call this before email__propose_campaign, which needs an " +
    "audience_id from here. With several tools connected and no tool named, every list carries its tool (pass that as route with its id as audience_id), " +
    "notes holds each tool's note, and unreadable names any tool that could not be read. " +
    "Zavi's own contact lists are not here: read those with outbound__list_email_lists and propose with list_id. " +
    "Throws email_tool_not_connected when no email tool is connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (!args.tool) {
      const { connected, failed } = await connectedEmailTools(ctx.tenant_id);
      if (connected.length + failed.length > 1) return readEveryTool(ctx.tenant_id, connected, failed);
      if (connected.length === 1) return readOneTool(ctx.tenant_id, connected[0]);
    }
    return readOneTool(ctx.tenant_id, await resolveEmailTool(ctx.tenant_id, args.tool));
  },
};
