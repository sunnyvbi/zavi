
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import type { CallMcpContext } from "../execute";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { getConnectorToken } from "@/services/connectors/core/token";

const searchInput = z.object({
  query: z.string().min(1).describe("Free-text issue search"),
  max_results: z.number().int().min(1).max(50).default(20),
});
const getIssueInput = z.object({
  issue_id: z.string().min(1).describe("Linear issue id or identifier (e.g. ENG-12)"),
});
const listUsersInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Substring to match against user name / displayName / email (case-insensitive).",
    ),
  max_results: z.number().int().min(1).max(50).default(10),
});
const getUserInput = z.object({
  user_id: z.string().min(1).describe("Linear user UUID (from list_users)."),
});
const listTeamsInput = z.object({
  max_results: z.number().int().min(1).max(100).default(50),
});
const getTeamInput = z.object({
  team_id: z
    .string()
    .min(1)
    .describe("Linear team UUID or short key (e.g. ENG)."),
});
const listProjectsInput = z.object({
  max_results: z.number().int().min(1).max(100).default(50),
});
const listMyIssuesInput = z.object({
  max_results: z.number().int().min(1).max(50).default(20),
});
export const createIssueInput = z.object({
  team_id: z.string().min(1).describe("Linear team UUID"),
  title: z.string().min(1).max(255),
  description_markdown: z.string().max(30000).default(""),
});
export const addCommentInput = z.object({
  issue_id: z.string().min(1),
  body_markdown: z.string().min(1).max(30000),
});

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const READ_SPECS: Record<string, SpecEntry> = {
  search: {
    description:
      "Search Linear issues by free text. Returns id, identifier, title, state plus an `agent_hints` envelope that flags truncation and likely display-name-instead-of-UUID query mistakes. IMPORTANT: Linear GraphQL filters take user.id (UUID) and team.id (UUID) — display-name strings are silently ignored. If the question names a person, call `list_users` FIRST and plug the UUID into the search filter.",
    schema: searchInput,
    effect: "read",
  },
  get_issue: {
    description: "Fetch one Linear issue by id/identifier (e.g. ENG-12).",
    schema: getIssueInput,
    effect: "read",
  },
  list_users: {
    description:
      "Resolve a person's name, displayName, or email substring to one or more Linear user records (id, name, displayName, email, active). ALWAYS call this BEFORE writing a Linear search that filters by assignee/creator/subscriber — Linear GraphQL takes user.id (UUID), not display names. Example: user asks 'show me Linear issues assigned to Catherine' → call list_users(query='Catherine') → take the highest-confidence active:true match's `id` → use that UUID with linear__search, or call linear__get_user for full profile. Same shape as Jira's accountId-required-not-display-name pattern.",
    schema: listUsersInput,
    effect: "read",
  },
  get_user: {
    description:
      "Fetch one Linear user by UUID — name, displayName, email, active, admin, createdAt. Use after `list_users` resolves a display name to UUID, or when a tool result hands you a userId.",
    schema: getUserInput,
    effect: "read",
  },
  list_teams: {
    description:
      "List Linear teams in the workspace (id UUID, key like 'ENG', name, description). Linear's primary grouping above projects; teams own issues. Use to discover team scoping before issuing a team-filtered search.",
    schema: listTeamsInput,
    effect: "read",
  },
  get_team: {
    description:
      "Fetch one Linear team by UUID or key (e.g. 'ENG'). Returns id, key, name, description, member_count.",
    schema: getTeamInput,
    effect: "read",
  },
  list_projects: {
    description:
      "List active Linear projects (id, name, state, startDate, targetDate). Use to scope a search by project id, or to answer 'what projects do we have'.",
    schema: listProjectsInput,
    effect: "read",
  },
  list_my_issues: {
    description:
      "Issues currently assigned to the connected Linear user (the bot token's identity), filtered to non-completed states. Returns id, identifier, title, state, priority, dueDate. Use for 'what's on my plate' style questions — no user lookup needed.",
    schema: listMyIssuesInput,
    effect: "read",
  },
};

const WRITE_SPECS: Record<string, SpecEntry> = {
  create_issue: {
    description:
      "Create a Linear issue. NEVER from the agent loop — dispatch-decision only (linear.create_issue).",
    schema: createIssueInput,
    effect: "write",
  },
  add_comment: {
    description: "Comment on a Linear issue. dispatch-decision only (linear.add_comment).",
    schema: addCommentInput,
    effect: "write",
  },
};

const ALL_SPECS: Record<string, SpecEntry> = { ...READ_SPECS, ...WRITE_SPECS };

export function listLinearHiddenWriteToolEffects(): Array<{ tool_name: string; effect: ToolEffect }> {
  return Object.entries(WRITE_SPECS)
    .filter(([tool_name]) => !(tool_name in READ_SPECS))
    .map(([tool_name, spec]) => ({ tool_name, effect: spec.effect }));
}

export function listLinearTools(): McpTool[] {
  return Object.entries(READ_SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`linear/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "linear",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export const AGENT_AUTO_SENTINEL = "[agent-auto]";

async function linearGraphQL(
  tenant_id: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = await getConnectorToken(tenant_id, "linear", "linear.access_token");
  if (!token) {
    throw new ExpectedToolError(
      "linear_not_connected",
      "Linear is not connected for this workspace. Connect it from Settings → Connectors.",
    );
  }
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    throw new ExpectedToolError(
      "linear_auth_expired",
      "Linear rejected the token (401). Reconnect Linear from Settings → Connectors.",
    );
  }
  if (!res.ok) {
    throw new ExpectedToolError("linear_http_error", `Linear API ${res.status}`);
  }
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (json.errors) {
    throw new ExpectedToolError(
      "linear_graphql_error",
      `Linear GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`,
    );
  }
  return json.data ?? {};
}

const TEAM_KEY_SHAPE = /^[A-Z]{2,5}-?\d*$/;
const DISPLAY_NAME_SHAPE = /^[a-z]{3,15}$/i;
function looksLikeDisplayName(q: string): boolean {
  const trimmed = q.trim();
  return DISPLAY_NAME_SHAPE.test(trimmed) && !TEAM_KEY_SHAPE.test(trimmed);
}

async function runTool(
  tenant_id: string,
  tool_name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (tool_name === "search") {
    const a = args as z.infer<typeof searchInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($q:String!,$n:Int!){ issueSearch(query:$q, first:$n){ nodes{ id identifier title url state{ name } } } }`,
      { q: a.query, n: a.max_results },
    );
    const nodes =
      ((data.issueSearch as { nodes?: unknown[] } | undefined)?.nodes ?? []) as unknown[];
    const hints: Record<string, unknown> = {};
    if (nodes.length === 0 && looksLikeDisplayName(a.query)) {
      hints.empty_due_to_likely_displayname = true;
      hints.suggested_lookup_name = a.query.trim();
      hints.suggestion = `Linear's filter system takes user.id (UUID), not display names. Call linear__list_users(query='${a.query.trim()}') first to resolve the UUID, then retry search with the assigneeId.`;
    }
    if (nodes.length >= a.max_results) {
      hints.likely_truncated = true;
      hints.suggestion = `Linear's issueSearch doesn't return a total count. ${a.max_results} returned — more may exist. Narrow the query (project, state, date range) to confirm.`;
    }
    return Object.keys(hints).length > 0 ? { ...data, agent_hints: hints } : data;
  }
  if (tool_name === "get_issue") {
    const a = args as z.infer<typeof getIssueInput>;
    return linearGraphQL(
      tenant_id,
      `query($id:String!){ issue(id:$id){ id identifier title description state{ name } } }`,
      { id: a.issue_id },
    );
  }
  if (tool_name === "list_users") {
    const a = args as z.infer<typeof listUsersInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($q:String!,$n:Int!){ users(first:$n, filter:{ or:[{name:{containsIgnoreCase:$q}},{displayName:{containsIgnoreCase:$q}},{email:{containsIgnoreCase:$q}}] }){ nodes{ id name displayName email active } } }`,
      { q: a.query, n: a.max_results },
    );
    const nodes =
      ((data.users as { nodes?: Array<{ id?: string; name?: string; displayName?: string; email?: string; active?: boolean }> } | undefined)?.nodes ?? []);
    return {
      users: nodes.map((u) => ({
        id: String(u.id ?? ""),
        name: String(u.name ?? ""),
        display_name: String(u.displayName ?? ""),
        email: u.email ?? null,
        active: Boolean(u.active),
      })),
    };
  }
  if (tool_name === "get_user") {
    const a = args as z.infer<typeof getUserInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($id:String!){ user(id:$id){ id name displayName email active createdAt admin } }`,
      { id: a.user_id },
    );
    const u = (data.user as
      | {
          id?: string;
          name?: string;
          displayName?: string;
          email?: string;
          active?: boolean;
          createdAt?: string;
          admin?: boolean;
        }
      | undefined) ?? {};
    return {
      id: String(u.id ?? a.user_id),
      name: String(u.name ?? ""),
      display_name: String(u.displayName ?? ""),
      email: u.email ?? null,
      active: Boolean(u.active),
      admin: Boolean(u.admin),
      created_at: u.createdAt ?? null,
    };
  }
  if (tool_name === "list_teams") {
    const a = args as z.infer<typeof listTeamsInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($n:Int!){ teams(first:$n){ nodes{ id key name description } } }`,
      { n: a.max_results },
    );
    const nodes =
      ((data.teams as { nodes?: Array<{ id?: string; key?: string; name?: string; description?: string }> } | undefined)?.nodes ?? []);
    return {
      teams: nodes.map((t) => ({
        id: String(t.id ?? ""),
        key: String(t.key ?? ""),
        name: String(t.name ?? ""),
        description: t.description ?? "",
      })),
    };
  }
  if (tool_name === "get_team") {
    const a = args as z.infer<typeof getTeamInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($id:String!){ team(id:$id){ id key name description members{ nodes{ id } } } }`,
      { id: a.team_id },
    );
    const t = (data.team as
      | {
          id?: string;
          key?: string;
          name?: string;
          description?: string;
          members?: { nodes?: Array<{ id?: string }> };
        }
      | undefined) ?? {};
    return {
      id: String(t.id ?? a.team_id),
      key: String(t.key ?? ""),
      name: String(t.name ?? ""),
      description: t.description ?? "",
      member_count: (t.members?.nodes ?? []).length,
    };
  }
  if (tool_name === "list_projects") {
    const a = args as z.infer<typeof listProjectsInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($n:Int!){ projects(first:$n){ nodes{ id name state startDate targetDate } } }`,
      { n: a.max_results },
    );
    const nodes =
      ((data.projects as { nodes?: Array<{ id?: string; name?: string; state?: string; startDate?: string; targetDate?: string }> } | undefined)?.nodes ?? []);
    return {
      projects: nodes.map((p) => ({
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        state: p.state ?? "",
        start_date: p.startDate ?? null,
        target_date: p.targetDate ?? null,
      })),
    };
  }
  if (tool_name === "list_my_issues") {
    const a = args as z.infer<typeof listMyIssuesInput>;
    const data = await linearGraphQL(
      tenant_id,
      `query($n:Int!){ viewer{ assignedIssues(first:$n, filter:{ state:{ type:{ neq:"completed" } } }){ nodes{ id identifier title state{ name } priority dueDate } } } }`,
      { n: a.max_results },
    );
    const nodes =
      ((data.viewer as { assignedIssues?: { nodes?: Array<{ id?: string; identifier?: string; title?: string; state?: { name?: string }; priority?: number; dueDate?: string }> } } | undefined)?.assignedIssues?.nodes ?? []);
    return {
      issues: nodes.map((i) => ({
        id: String(i.id ?? ""),
        identifier: String(i.identifier ?? ""),
        title: String(i.title ?? ""),
        state: i.state?.name ?? "",
        priority: typeof i.priority === "number" ? i.priority : null,
        due_date: i.dueDate ?? null,
      })),
    };
  }
  throw new ExpectedToolError("tool_unknown", `linear/${tool_name} not a read tool`);
}

export async function linearCreateIssue(
  tenant_id: string,
  input: z.infer<typeof createIssueInput>,
): Promise<{ id: string; identifier: string; url: string }> {
  const a = createIssueInput.parse(input);
  const data = await linearGraphQL(
    tenant_id,
    `mutation($t:String!,$ti:String!,$d:String){ issueCreate(input:{ teamId:$t, title:$ti, description:$d }){ issue{ id identifier url } } }`,
    { t: a.team_id, ti: a.title, d: a.description_markdown },
  );
  const issue = (data.issueCreate as { issue?: { id?: string; identifier?: string; url?: string } } | undefined)
    ?.issue;
  return {
    id: String(issue?.id ?? ""),
    identifier: String(issue?.identifier ?? ""),
    url: String(issue?.url ?? ""),
  };
}

export async function linearAddComment(
  tenant_id: string,
  input: z.infer<typeof addCommentInput>,
  opts: { agentAuto?: boolean } = {},
): Promise<{ id: string }> {
  const a = addCommentInput.parse(input);
  const bodyText = opts.agentAuto
    ? `${AGENT_AUTO_SENTINEL} ${a.body_markdown}`
    : a.body_markdown;
  const data = await linearGraphQL(
    tenant_id,
    `mutation($i:String!,$b:String!){ commentCreate(input:{ issueId:$i, body:$b }){ comment{ id } } }`,
    { i: a.issue_id, b: bodyText },
  );
  const id = (data.commentCreate as { comment?: { id?: string } } | undefined)?.comment?.id;
  return { id: String(id ?? "") };
}

export type TrackerComment = { id: string; created: string; text: string };

export async function linearListComments(
  tenant_id: string,
  issue_id: string,
): Promise<TrackerComment[]> {
  const data = await linearGraphQL(
    tenant_id,
    `query($id:String!){ issue(id:$id){ comments(first:50){ nodes{ id createdAt body } } } }`,
    { id: issue_id },
  );
  const nodes =
    (
      data.issue as
        | { comments?: { nodes?: Array<{ id?: string; createdAt?: string; body?: string }> } }
        | undefined
    )?.comments?.nodes ?? [];
  return nodes.map((c) => ({
    id: String(c.id ?? ""),
    created: String(c.createdAt ?? ""),
    text: String(c.body ?? "").trim(),
  }));
}

export async function callLinearTool(
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
      content: JSON.stringify({ error: "tool_unknown", message: `linear/${tool_name} not registered` }),
      ms: Date.now() - start,
    };
  }
  try {
    const parsed = spec.schema.parse(args) as Record<string, unknown>;
    let output: unknown;
    if (tool_name === "create_issue") {
      output = await linearCreateIssue(ctx.tenant_id, parsed as z.infer<typeof createIssueInput>);
    } else if (tool_name === "add_comment") {
      output = await linearAddComment(ctx.tenant_id, parsed as z.infer<typeof addCommentInput>);
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
