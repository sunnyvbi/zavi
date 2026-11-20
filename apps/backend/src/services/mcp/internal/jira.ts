
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import type { CallMcpContext } from "../execute";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import {
  getConnectorToken,
  forceRefreshConnector,
} from "@/services/connectors/core/token";
import { getSecret } from "@/services/secrets/vault";

const searchInput = z.object({
  jql: z.string().min(1).describe("JQL query, e.g. `project = ENG AND status = Open`"),
  max_results: z.number().int().min(1).max(50).default(20),
});
const countInput = z.object({
  jql: z
    .string()
    .min(1)
    .describe(
      "JQL whose matching-issue COUNT you want, e.g. `project = ENG AND statusCategory != Done`. Same accountId rule as search: resolve people via lookup_account_id FIRST.",
    ),
});
const getIssueInput = z.object({
  issue_key: z.string().min(1).describe("e.g. ENG-1234"),
});
const lookupAccountIdInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Display name, full name fragment, or email to resolve to an Atlassian accountId.",
    ),
  max_results: z.number().int().min(1).max(50).default(10),
});
const getVisibleProjectsInput = z.object({});
const getIssueTypeMetadataInput = z.object({
  project_key: z.string().min(1).describe("e.g. ENG"),
});
const getTransitionsInput = z.object({
  issue_key: z.string().min(1).describe("e.g. ENG-1234"),
});
const getIssueRemoteLinksInput = z.object({
  issue_key: z.string().min(1).describe("e.g. ENG-1234"),
});
const atlassianUserInfoInput = z.object({});
const getAttachmentInput = z.object({
  attachment_id: z
    .string()
    .min(1)
    .describe("Attachment id from get_issue's attachments[].id"),
});
export const createIssueInput = z.object({
  project_key: z.string().min(1),
  issue_type: z.string().min(1).default("Task"),
  summary: z.string().min(1).max(255),
  description_markdown: z.string().max(30000).default(""),
});
export const addCommentInput = z.object({
  issue_key: z.string().min(1),
  body_markdown: z.string().min(1).max(30000),
});

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const READ_SPECS: Record<string, SpecEntry> = {
  search: {
    description:
      "Search JIRA issues by JQL. Returns up to max_results issues (key, summary, status, assignee) plus an `agent_hints` envelope that flags truncation and likely-display-name JQL mistakes. IMPORTANT: JQL `assignee`/`reporter` filters require an accountId, not a display name — Atlassian Cloud has rejected display-name strings since the 2019 GDPR migration. If the question names a person, call `lookup_account_id` FIRST and plug the returned accountId into JQL. Example: user asks 'tickets for Jemis' → call lookup_account_id(query='Jemis') → call search(jql='assignee = \"<accountId>\"').",
    schema: searchInput,
    effect: "read",
  },
  count: {
    description:
      'Return the EXACT number of issues matching a JQL — one call, no issue bodies, never truncates. ALWAYS use this for "how many" / count / tally questions instead of search+counting rows (search pages out at 50 and has no total). Same accountId rule: if the question names a person, call lookup_account_id FIRST and use the accountId in the JQL. Scope to one project with `project = "<KEY>"`. Returns `{count, jql}`.',
    schema: countInput,
    effect: "read",
  },
  get_issue: {
    description:
      "Fetch one JIRA issue by key. Returns readable plain-text `description` (Atlassian ADF is converted to text), plus summary, status, issuetype, priority, labels, assignee, reporter, the comment thread as text, and an `attachments` list ([{id, filename, mimeType, size, content_url}]). Pass an attachment id to get_attachment to read an attached file's contents.",
    schema: getIssueInput,
    effect: "read",
  },
  get_attachment: {
    description:
      "Read a Jira attachment's text content by id (get the id from get_issue's `attachments[].id`). Returns {id, filename, mimeType, size, text} for text/JSON/markdown/CSV/XML attachments; for binary types (images, PDFs, archives) returns metadata + content_url only (text:null). Use after get_issue when you need to read an attached file.",
    schema: getAttachmentInput,
    effect: "read",
  },
  lookup_account_id: {
    description:
      "Resolve a person's display name, full name fragment, or email to one or more Atlassian `accountId` values. ALWAYS call this BEFORE writing JQL that filters by `assignee`/`reporter` to a person. Returns `[{accountId, displayName, emailAddress, active}]` ranked by Atlassian's match quality — pick the highest-confidence `active:true` row. Example: 'tickets for Jemis' → lookup_account_id(query='Jemis') → take accountId → search(jql='assignee = \"<accountId>\"'). Without this two-step, JQL with display-name strings returns 0 results silently.",
    schema: lookupAccountIdInput,
    effect: "read",
  },
  get_visible_projects: {
    description:
      "List Jira projects the connected token can see (`[{id, key, name, projectTypeKey}]`). Use to scope a search to a specific project or to answer 'what projects do we have'.",
    schema: getVisibleProjectsInput,
    effect: "read",
  },
  get_issue_type_metadata: {
    description:
      "List issue types in a project + the fields each type accepts. Useful before writing JQL that filters by issuetype, or to know which custom fields exist.",
    schema: getIssueTypeMetadataInput,
    effect: "read",
  },
  get_transitions: {
    description:
      "List the workflow transitions available on an issue (READ-ONLY; does not execute the transition). Returns `[{id, name, to: {id, name}}]`.",
    schema: getTransitionsInput,
    effect: "read",
  },
  get_issue_remote_links: {
    description:
      "List external pages linked to a Jira issue (Confluence pages, GitHub PRs, etc.). Useful when an issue mentions 'see linked doc' and you need the URL.",
    schema: getIssueRemoteLinksInput,
    effect: "read",
  },
  atlassian_user_info: {
    description:
      "Return the connected Jira account's own identity — `{accountId, displayName, emailAddress}`. Sanity check + answers 'who am I as Praxis sees Jira'.",
    schema: atlassianUserInfoInput,
    effect: "read",
  },
};

const WRITE_SPECS: Record<string, SpecEntry> = {
  create_issue: {
    description:
      "Create a JIRA issue. NEVER called from the agent loop — only invoked by dispatch-decision after the jira.create_issue decision is approved.",
    schema: createIssueInput,
    effect: "write",
  },
  add_comment: {
    description:
      "Add a comment to a JIRA issue. dispatch-decision only (jira.add_comment decision).",
    schema: addCommentInput,
    effect: "write",
  },
};

const ALL_SPECS: Record<string, SpecEntry> = { ...READ_SPECS, ...WRITE_SPECS };

export function listJiraHiddenWriteToolEffects(): Array<{ tool_name: string; effect: ToolEffect }> {
  return Object.entries(WRITE_SPECS)
    .filter(([tool_name]) => !(tool_name in READ_SPECS))
    .map(([tool_name, spec]) => ({ tool_name, effect: spec.effect }));
}

export function listJiraTools(): McpTool[] {
  return Object.entries(READ_SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`jira/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "jira",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

function mdToAdf(md: string): unknown {
  const paragraphs = md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const content =
    paragraphs.length === 0
      ? [{ type: "paragraph", content: [{ type: "text", text: " " }] }]
      : paragraphs.map((p) => ({
          type: "paragraph",
          content: [{ type: "text", text: p }],
        }));
  return { type: "doc", version: 1, content };
}

export const AGENT_AUTO_SENTINEL = "[agent-auto]";

async function jiraCreds(
  tenant_id: string,
): Promise<{ token: string; cloudId: string }> {
  const token = await getConnectorToken(tenant_id, "jira", "jira.access_token");
  const cloudId = await getSecret(tenant_id, "jira.cloud_id");
  if (!token || !cloudId) {
    throw new ExpectedToolError(
      "jira_not_connected",
      "JIRA is not connected for this workspace. Connect it from Settings → Connectors.",
    );
  }
  return { token, cloudId };
}

async function jiraFetch(
  tenant_id: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const { token, cloudId } = await jiraCreds(tenant_id);
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    try {
      await forceRefreshConnector(tenant_id, "jira");
    } catch (e) {
      throw new ExpectedToolError(
        "jira_auth_expired",
        `JIRA token refresh failed (${(e as Error).message.slice(0, 120)}). Reconnect JIRA from Settings → Connectors.`,
      );
    }
    const { token: freshToken } = await jiraCreds(tenant_id);
    const retryRes = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
        Authorization: `Bearer ${freshToken}`,
      },
    });
    if (retryRes.status === 401) {
      throw new ExpectedToolError(
        "jira_auth_expired",
        "JIRA rejected the access token after a forced refresh (401). Reconnect JIRA from Settings → Connectors.",
      );
    }
    if (!retryRes.ok) {
      const text = await retryRes.text().catch(() => "");
      throw new ExpectedToolError(
        "jira_http_error",
        `JIRA API ${retryRes.status}: ${text.slice(0, 300)}`,
      );
    }
    return retryRes.json();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ExpectedToolError(
      "jira_http_error",
      `JIRA API ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  if (res.status === 204) return {};
  return res.json();
}

async function jiraFetchTextContent(
  tenant_id: string,
  path: string,
): Promise<{ text: string }> {
  const { token, cloudId } = await jiraCreds(tenant_id);
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new ExpectedToolError(
      "jira_http_error",
      `JIRA attachment ${res.status}: ${t.slice(0, 200)}`,
    );
  }
  return { text: await res.text() };
}

const ACCOUNT_ID_SHAPE = /^[0-9a-f-]{24,}$|^557058:|^61[0-9a-f]{20,}/i;
const ASSIGNEE_NAME_PATTERN =
  /\b(assignee|reporter)\s*=\s*"([^"]+)"/i;

function searchAgentHints(
  jql: string,
  total: number,
  returned: number,
  maxResults: number,
  raw?: { isLast?: unknown; nextPageToken?: unknown },
): Record<string, unknown> | undefined {
  const hints: Record<string, unknown> = {};
  const tokenBased =
    raw?.isLast === false || typeof raw?.nextPageToken === "string";
  const countBased = total > returned;
  if (tokenBased || countBased) {
    hints.truncated = true;
    hints.returned = returned;
    if (countBased) hints.total = total;
    if (tokenBased && typeof raw?.nextPageToken === "string") {
      hints.next_page_token = raw.nextPageToken;
    }
    hints.suggestion = countBased
      ? `Results capped at ${maxResults}. Total is ${total}. Use a more specific JQL or paginate with nextPageToken.`
      : `Results capped at ${maxResults}; more pages available via nextPageToken. Use a more specific JQL or paginate.`;
  }
  if (returned === 0) {
    const m = jql.match(ASSIGNEE_NAME_PATTERN);
    if (m && m[2] && !ACCOUNT_ID_SHAPE.test(m[2])) {
      hints.empty_due_to_likely_displayname = true;
      hints.suggested_lookup_name = m[2];
      hints.suggestion = `JQL ${m[1]} requires an accountId, not a display name. Call jira__lookup_account_id(query='${m[2]}') first, take the accountId, then retry search.`;
    }
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

async function runTool(
  tenant_id: string,
  tool_name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool_name) {
    case "search": {
      const a = args as z.infer<typeof searchInput>;
      const body = JSON.stringify({
        jql: a.jql,
        maxResults: a.max_results,
        fields: ["summary", "status", "assignee"],
      });
      const raw = (await jiraFetch(tenant_id, "/search/jql", {
        method: "POST",
        body,
      })) as {
        issues?: unknown[];
        total?: number;
        isLast?: unknown;
        nextPageToken?: unknown;
      } & Record<string, unknown>;
      const issues = Array.isArray(raw.issues) ? raw.issues : [];
      const total = typeof raw.total === "number" ? raw.total : issues.length;
      const hints = searchAgentHints(
        a.jql,
        total,
        issues.length,
        a.max_results,
        { isLast: raw.isLast, nextPageToken: raw.nextPageToken },
      );
      return hints ? { ...raw, agent_hints: hints } : raw;
    }
    case "count": {
      const a = args as z.infer<typeof countInput>;
      const raw = (await jiraFetch(tenant_id, "/search/approximate-count", {
        method: "POST",
        body: JSON.stringify({ jql: a.jql }),
      })) as { count?: number };
      const count = typeof raw.count === "number" ? raw.count : 0;
      if (count === 0) {
        const m = a.jql.match(ASSIGNEE_NAME_PATTERN);
        if (m && m[2] && !ACCOUNT_ID_SHAPE.test(m[2])) {
          return {
            count: 0,
            jql: a.jql,
            agent_hints: {
              empty_due_to_likely_displayname: true,
              suggested_lookup_name: m[2],
              suggestion: `Count is 0 but JQL ${m[1]} uses a display name. Call jira__lookup_account_id(query='${m[2]}') first, then re-count with the accountId.`,
            },
          };
        }
      }
      return { count, jql: a.jql };
    }
    case "get_issue": {
      const a = args as z.infer<typeof getIssueInput>;
      const raw = (await jiraFetch(
        tenant_id,
        `/issue/${encodeURIComponent(a.issue_key)}?fields=summary,status,issuetype,priority,labels,assignee,reporter,description,attachment,comment`,
        { method: "GET" },
      )) as {
        key?: string;
        fields?: {
          summary?: string;
          status?: { name?: string };
          issuetype?: { name?: string };
          priority?: { name?: string };
          labels?: string[];
          assignee?: { displayName?: string } | null;
          reporter?: { displayName?: string } | null;
          description?: unknown;
          attachment?: Array<{
            id?: string;
            filename?: string;
            mimeType?: string;
            size?: number;
            content?: string;
          }>;
          comment?: {
            comments?: Array<{
              author?: { displayName?: string };
              created?: string;
              body?: unknown;
            }>;
          };
        };
      };
      const f = raw.fields ?? {};
      return {
        key: String(raw.key ?? a.issue_key),
        summary: String(f.summary ?? ""),
        status: f.status?.name ?? null,
        issuetype: f.issuetype?.name ?? null,
        priority: f.priority?.name ?? null,
        labels: Array.isArray(f.labels) ? f.labels : [],
        assignee: f.assignee?.displayName ?? null,
        reporter: f.reporter?.displayName ?? null,
        description: f.description ? adfToText(f.description).trim() : "",
        attachments: (f.attachment ?? []).map((at) => ({
          id: String(at.id ?? ""),
          filename: String(at.filename ?? ""),
          mimeType: String(at.mimeType ?? ""),
          size: typeof at.size === "number" ? at.size : null,
          content_url: String(at.content ?? ""),
        })),
        comments: (f.comment?.comments ?? []).map((c) => ({
          author: c.author?.displayName ?? null,
          created: String(c.created ?? ""),
          text: adfToText(c.body).trim(),
        })),
      };
    }
    case "get_attachment": {
      const a = args as z.infer<typeof getAttachmentInput>;
      const meta = (await jiraFetch(
        tenant_id,
        `/attachment/${encodeURIComponent(a.attachment_id)}`,
        { method: "GET" },
      )) as {
        id?: string;
        filename?: string;
        mimeType?: string;
        size?: number;
        content?: string;
      };
      const mime = String(meta.mimeType ?? "");
      const isText =
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime === "application/xml" ||
        /(markdown|csv|x-yaml|yaml)/.test(mime);
      const base = {
        id: String(meta.id ?? a.attachment_id),
        filename: String(meta.filename ?? ""),
        mimeType: mime,
        size: typeof meta.size === "number" ? meta.size : null,
        content_url: String(meta.content ?? ""),
      };
      if (!isText) {
        return {
          ...base,
          text: null,
          note: "Binary attachment — no text extracted. Use content_url to download.",
        };
      }
      const { text } = await jiraFetchTextContent(
        tenant_id,
        `/attachment/content/${encodeURIComponent(a.attachment_id)}`,
      );
      return { ...base, text: text.slice(0, 12000) };
    }
    case "lookup_account_id": {
      const a = args as z.infer<typeof lookupAccountIdInput>;
      const qs = new URLSearchParams({
        query: a.query,
        maxResults: String(a.max_results),
      });
      const raw = (await jiraFetch(tenant_id, `/user/search?${qs.toString()}`, {
        method: "GET",
      })) as Array<{
        accountId?: string;
        displayName?: string;
        emailAddress?: string;
        active?: boolean;
      }>;
      return (Array.isArray(raw) ? raw : []).map((u) => ({
        accountId: String(u.accountId ?? ""),
        displayName: String(u.displayName ?? ""),
        emailAddress: u.emailAddress ?? null,
        active: Boolean(u.active),
      }));
    }
    case "get_visible_projects": {
      const raw = (await jiraFetch(
        tenant_id,
        `/project/search?maxResults=50`,
        { method: "GET" },
      )) as {
        values?: Array<{
          id?: string;
          key?: string;
          name?: string;
          projectTypeKey?: string;
        }>;
      };
      return (raw.values ?? []).map((p) => ({
        id: String(p.id ?? ""),
        key: String(p.key ?? ""),
        name: String(p.name ?? ""),
        projectTypeKey: String(p.projectTypeKey ?? ""),
      }));
    }
    case "get_issue_type_metadata": {
      const a = args as z.infer<typeof getIssueTypeMetadataInput>;
      return jiraFetch(
        tenant_id,
        `/issue/createmeta/${encodeURIComponent(a.project_key)}/issuetypes`,
        { method: "GET" },
      );
    }
    case "get_transitions": {
      const a = args as z.infer<typeof getTransitionsInput>;
      return jiraFetch(
        tenant_id,
        `/issue/${encodeURIComponent(a.issue_key)}/transitions`,
        { method: "GET" },
      );
    }
    case "get_issue_remote_links": {
      const a = args as z.infer<typeof getIssueRemoteLinksInput>;
      return jiraFetch(
        tenant_id,
        `/issue/${encodeURIComponent(a.issue_key)}/remotelink`,
        { method: "GET" },
      );
    }
    case "atlassian_user_info": {
      return jiraFetch(tenant_id, `/myself`, { method: "GET" });
    }
    default:
      throw new ExpectedToolError("tool_unknown", `jira/${tool_name} not a read tool`);
  }
}

export async function jiraCreateIssue(
  tenant_id: string,
  input: z.infer<typeof createIssueInput>,
): Promise<{ key: string; id: string; url: string }> {
  const a = createIssueInput.parse(input);
  const body = JSON.stringify({
    fields: {
      project: { key: a.project_key },
      issuetype: { name: a.issue_type },
      summary: a.summary,
      description: mdToAdf(a.description_markdown),
    },
  });
  const res = (await jiraFetch(tenant_id, "/issue", {
    method: "POST",
    body,
  })) as { key?: string; id?: string };
  return {
    key: String(res.key ?? ""),
    id: String(res.id ?? ""),
    url: res.key ? `/browse/${res.key}` : "",
  };
}

export async function jiraAddComment(
  tenant_id: string,
  input: z.infer<typeof addCommentInput>,
  opts: { agentAuto?: boolean } = {},
): Promise<{ id: string }> {
  const a = addCommentInput.parse(input);
  const text = opts.agentAuto
    ? `${AGENT_AUTO_SENTINEL} ${a.body_markdown}`
    : a.body_markdown;
  const res = (await jiraFetch(
    tenant_id,
    `/issue/${encodeURIComponent(a.issue_key)}/comment`,
    { method: "POST", body: JSON.stringify({ body: mdToAdf(text) }) },
  )) as { id?: string };
  return { id: String(res.id ?? "") };
}

function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    return n.content.map(adfToText).join(n.type === "paragraph" ? "" : "\n");
  }
  return "";
}

export type TrackerComment = { id: string; created: string; text: string };

export async function jiraListComments(
  tenant_id: string,
  issue_key: string,
): Promise<TrackerComment[]> {
  const res = (await jiraFetch(
    tenant_id,
    `/issue/${encodeURIComponent(issue_key)}/comment?orderBy=created&maxResults=50`,
    { method: "GET" },
  )) as { comments?: Array<{ id?: string; created?: string; body?: unknown }> };
  return (res.comments ?? []).map((c) => ({
    id: String(c.id ?? ""),
    created: String(c.created ?? ""),
    text: adfToText(c.body).trim(),
  }));
}

export async function callJiraTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = ALL_SPECS[tool_name];
  if (!spec) {
    return {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "tool_unknown", message: `jira/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsed = spec.schema.parse(args) as Record<string, unknown>;
    let output: unknown;
    if (tool_name === "create_issue") {
      output = await jiraCreateIssue(ctx.tenant_id, parsed as z.infer<typeof createIssueInput>);
    } else if (tool_name === "add_comment") {
      output = await jiraAddComment(ctx.tenant_id, parsed as z.infer<typeof addCommentInput>);
    } else {
      output = await runTool(ctx.tenant_id, tool_name, parsed);
    }
    return { ok: true, is_error: false, content: JSON.stringify(output), ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: e.code, message: e.message }),
        ms: Date.now() - start,
      };
    }
    if ((e as { name?: string })?.name === "ZodError") {
      return {
        ok: false,
        is_error: true,
        content: JSON.stringify({ error: "tool_input_invalid", message: (e as Error).message }),
        ms: Date.now() - start,
      };
    }
    throw e;
  }
}
