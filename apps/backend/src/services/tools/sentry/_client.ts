
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { SENTRY_VAULT_KEYS, SENTRY_API_BASE } from "./keys";

const REQUEST_TIMEOUT_MS = 30_000;

export type SentryCreds = {
  auth_token: string;
  org_slug: string;
};

export async function sentryCreds(tenant_id: string): Promise<SentryCreds> {
  const [authToken, orgSlug] = await Promise.all([
    getSecret(tenant_id, SENTRY_VAULT_KEYS.auth_token),
    getSecret(tenant_id, SENTRY_VAULT_KEYS.org_slug),
  ]);

  if (!authToken || !orgSlug) {
    throw new ExpectedToolError(
      "sentry_not_connected",
      "Sentry is not connected for this workspace. The operator connects it at Settings → Connectors → Sentry by pasting an org auth token. Until then, error/issue questions cannot be answered from Sentry.",
      {
        next_step: "operator_action",
        unblockers: ["Connect Sentry at Settings → Connectors"],
      },
    );
  }

  return { auth_token: authToken, org_slug: orgSlug };
}

async function sentryFetch(
  tenant_id: string,
  creds: SentryCreds,
  path: string,
  action: string,
): Promise<unknown> {
  const url = `${SENTRY_API_BASE}/organizations/${encodeURIComponent(creds.org_slug)}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.auth_token}` },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    throw new ExpectedToolError(
      "sentry_unreachable",
      "Sentry did not respond within 30s. Retry, or check status.sentry.io.",
      { next_step: "retry" },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("sentry_request_failed", { tenant_id, action, status: res.status });
    if (res.status === 401 || res.status === 403) {
      throw new ExpectedToolError(
        "sentry_key_rejected",
        "Sentry rejected the stored auth token (401/403). It was revoked, or it lacks the required scope. Reconnect Sentry at Settings → Connectors.",
        { next_step: "operator_action", unblockers: ["Reconnect Sentry with a token scoped for event:read and org:read"] },
      );
    }
    if (res.status === 404) {
      throw new ExpectedToolError(
        "sentry_not_found",
        "Sentry returned 404 for this request. Check the project and issue id.",
        { next_step: "revise_input" },
      );
    }
    throw new ExpectedToolError(
      "sentry_request_error",
      `Sentry returned HTTP ${res.status} for this request.`,
      { next_step: "retry" },
    );
  }

  return res.json();
}

export type SentryIssue = {
  id: string;
  shortId?: string;
  title: string;
  culprit: string | null;
  permalink?: string;
  level: string;
  status: string;
  count: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
};

export async function listIssues(
  tenant_id: string,
  opts: { project: string; query?: string; limit?: number },
): Promise<SentryIssue[]> {
  const creds = await sentryCreds(tenant_id);
  const params = new URLSearchParams({
    project: opts.project,
    query: opts.query ?? "is:unresolved",
    sort: "date",
    limit: String(opts.limit ?? 25),
  });
  const data = await sentryFetch(tenant_id, creds, `/issues/?${params.toString()}`, "list_issues");
  return Array.isArray(data) ? (data as SentryIssue[]) : [];
}

export type SentryStackFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  inApp?: boolean;
};

export type SentryIssueDetail = {
  issue: SentryIssue;
  latestEvent: {
    eventID?: string;
    dateCreated?: string;
    message?: string;
    frames: SentryStackFrame[];
  };
};

export async function getIssue(tenant_id: string, issue_id: string): Promise<SentryIssueDetail> {
  const creds = await sentryCreds(tenant_id);

  const [issueData, eventData] = await Promise.all([
    sentryFetch(tenant_id, creds, `/issues/${encodeURIComponent(issue_id)}/`, "get_issue"),
    sentryFetch(tenant_id, creds, `/issues/${encodeURIComponent(issue_id)}/events/latest/`, "get_issue_latest_event").catch(
      () => null,
    ),
  ]);

  const issue = issueData as SentryIssue;

  const entries = (eventData as { entries?: unknown } | null)?.entries;
  const frames: SentryStackFrame[] = [];
  if (Array.isArray(entries)) {
    for (const entry of entries as Array<{ type?: string; data?: unknown }>) {
      if (entry.type !== "exception") continue;
      const values = (entry.data as { values?: unknown } | undefined)?.values;
      if (!Array.isArray(values)) continue;
      for (const v of values as Array<{ stacktrace?: { frames?: unknown } }>) {
        const rawFrames = v.stacktrace?.frames;
        if (!Array.isArray(rawFrames)) continue;
        for (const f of rawFrames as Array<Record<string, unknown>>) {
          frames.push({
            filename: typeof f.filename === "string" ? f.filename : undefined,
            function: typeof f.function === "string" ? f.function : undefined,
            lineno: typeof f.lineNo === "number" ? f.lineNo : typeof f.lineno === "number" ? f.lineno : undefined,
            inApp: typeof f.inApp === "boolean" ? f.inApp : undefined,
          });
        }
      }
    }
  }

  return {
    issue,
    latestEvent: {
      eventID: typeof (eventData as { eventID?: unknown } | null)?.eventID === "string"
        ? (eventData as { eventID?: string }).eventID
        : undefined,
      dateCreated:
        typeof (eventData as { dateCreated?: unknown } | null)?.dateCreated === "string"
          ? (eventData as { dateCreated?: string }).dateCreated
          : undefined,
      message:
        typeof (eventData as { message?: unknown } | null)?.message === "string"
          ? (eventData as { message?: string }).message
          : undefined,
      frames: frames.slice(0, 50),
    },
  };
}
