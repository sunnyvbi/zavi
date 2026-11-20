
import type { DashboardBuilder } from "./_contract";
import {
  collectRecommendations,
  resolveContentSeoPublishRepo,
} from "@/agents/content-design/post-run";
import {
  AGENT_SLUG,
  OLD_AGENT_SLUG,
  DECISION_CLASSES,
} from "@/agents/content-design/constants";

type QueueRow = {
  id: string;
  source: "decision" | "run";
  title: string;
  target_keyword: string | null;
  change_type: string | null;
  file_action: "create" | "modify" | "delete" | null;
  status: string;
  emitted_at: string | null;
  expires_at: string | null;
  path: string | null;
  repo: string | null;
  base_branch: string | null;
  head_branch: string | null;
  recommendation_markdown: string | null;
  draft_markdown: string | null;
  changes?: { before: string; after: string }[] | null;
  run_id?: string;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function extractPostTitle(proposalTitle: string): string {
  const m = proposalTitle.match(/^content:\s*[a-z -]+\s*"(.*)"\s*$/i);
  return (m ? m[1] : proposalTitle).trim();
}

function extractKeyword(proposalBody: string): string | null {
  const m = proposalBody.match(/targeting\s+\*\*(.+?)\*\*/i);
  return m ? m[1].trim() : null;
}

function extractFirstFile(body: Record<string, unknown>): {
  path: string | null;
  action: "create" | "modify" | "delete" | null;
  content: string | null;
} {
  const files = body.files;
  if (Array.isArray(files)) {
    for (const f of files as Array<{ path?: unknown; action?: unknown; content?: unknown }>) {
      const path = typeof f.path === "string" && f.path.trim() ? f.path.trim() : null;
      const action =
        f.action === "create" || f.action === "modify" || f.action === "delete"
          ? f.action
          : null;
      const content = typeof f.content === "string" && f.content.trim() ? f.content : null;
      if (path || action || content) return { path, action, content };
    }
  }
  const m = asString(body.body).match(/(?:Published at|File): `([^`]+)`/i);
  return { path: m ? m[1].trim() : null, action: null, content: null };
}

function expiresAtForDecision(emittedAt: string | null): string | null {
  if (!emittedAt) return null;
  const emittedMs = Date.parse(emittedAt);
  if (!Number.isFinite(emittedMs)) return null;
  return new Date(emittedMs + 7 * 24 * 60 * 60 * 1000).toISOString();
}

export const build: DashboardBuilder = async (c) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  let queue: QueueRow[] = [];
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, body, status, emitted_at")
      .eq("tenant_id", c.tenantId)
      .in("decision_class", [...DECISION_CLASSES])
      .order("emitted_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    queue = (data ?? []).map((row) => {
      const r = row as {
        id: string;
        body: Record<string, unknown> | null;
        status: string | null;
        emitted_at: string | null;
      };
      const body = r.body ?? {};
      const file = extractFirstFile(body);
      return {
        id: r.id,
        source: "decision",
        title: extractPostTitle(asString(body.title)) || "(untitled content)",
        target_keyword: extractKeyword(asString(body.body)),
        change_type: asString(body.change_type) || null,
        file_action: file.action,
        status: r.status ?? "proposed",
        emitted_at: r.emitted_at,
        expires_at: expiresAtForDecision(r.emitted_at),
        path: file.path,
        repo: asString(body.repo) || null,
        base_branch: asString(body.base_branch) || null,
        head_branch: asString(body.head_branch) || null,
        recommendation_markdown: asString(body.rendered_markdown) || null,
        draft_markdown: file.content,
        changes: Array.isArray(body.changes)
          ? (body.changes as { before?: unknown; after?: unknown }[]).map((c) => ({
              before: asString(c?.before),
              after: asString(c?.after),
            }))
          : null,
      };
    });
  } catch {
    queue = [];
  }

  const prsOpened = queue.filter((r) => r.status === "acted").length;
  const pending = queue.filter((r) => r.status === "proposed").length;
  const queuedPaths = new Set(queue.map((r) => r.path).filter((p): p is string => Boolean(p)));

  let draftedLast30d = 0;
  let lastDraftAt: string | null = null;
  let lastRunAt: string | null = null;
  let lastRunOutput = "";
  let recoveredUnqueued = 0;
  const draftPathsLast30d = new Set<string>();
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, enqueued_at, output_text, parsed, parse_ok, status")
      .eq("tenant_id", c.tenantId)
      .in("agent_slug", [AGENT_SLUG, OLD_AGENT_SLUG])
      .gte("enqueued_at", sinceIso)
      .order("enqueued_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      id: string;
      enqueued_at: string | null;
      output_text: string | null;
      parsed: unknown;
      parse_ok: boolean | null;
      status: string | null;
    }>;
    if (rows.length > 0) {
      lastRunAt = rows[0].enqueued_at;
      lastRunOutput = asString(rows[0].output_text);
    }
    const recoveredRows: QueueRow[] = [];
    const seenRecoveredPaths = new Set<string>();
    for (const row of rows) {
      if (row.status !== "success" || row.parse_ok !== true) continue;
      const { recs } = collectRecommendations({
        parsed: row.parsed,
        output_text: row.output_text ?? "",
      });
      if (recs.length > 0 && !lastDraftAt) lastDraftAt = row.enqueued_at;
      for (const rec of recs) {
        const path = rec.path;
        draftPathsLast30d.add(path);
        if (queuedPaths.has(path) || seenRecoveredPaths.has(path)) continue;
        seenRecoveredPaths.add(path);
        recoveredRows.push({
          id: `${row.id}:${rec.slug}`,
          source: "run",
          run_id: row.id,
          title: rec.title,
          target_keyword: rec.target_keyword ?? null,
          change_type: rec.change_type,
          file_action: rec.action,
          status: "drafted_unqueued",
          emitted_at: row.enqueued_at,
          expires_at: null,
          path,
          repo: null,
          base_branch: null,
          head_branch: null,
          recommendation_markdown:
            [
              `**Recommendation — recovered SEO draft**`,
              ``,
              rec.target_keyword
                ? `**What:** ${rec.action === "create" ? "create" : "modify"} content targeting **${rec.target_keyword}**`
                : `**What:** ${rec.action === "create" ? "create" : "modify"} content`,
              `**Where:** \`${path}\` in your connected repo`,
              `**Proposed title:** ${rec.title}`,
              rec.rationale ? `**Why:** ${rec.rationale}` : "",
              rec.expected_impact ? `**Expected impact:** ${rec.expected_impact}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          draft_markdown: rec.body,
        });
      }
    }
    recoveredUnqueued = recoveredRows.length;
    queue = [...queue, ...recoveredRows.slice(0, 20)];
    draftedLast30d = draftPathsLast30d.size;
  } catch {
    draftedLast30d = 0;
    lastDraftAt = null;
    lastRunAt = null;
    lastRunOutput = "";
    recoveredUnqueued = 0;
  }

  for (const r of queue) {
    if (r.source !== "decision" || !r.emitted_at || new Date(r.emitted_at) < since) {
      continue;
    }
    draftPathsLast30d.add(r.path ?? r.id);
  }
  draftedLast30d = draftPathsLast30d.size;

  let hasPublishTarget: boolean | null = null;
  try {
    const target = await resolveContentSeoPublishRepo(c.tenantId);
    hasPublishTarget = target !== null;
  } catch {
    hasPublishTarget = null;
  }

  const attention: AttentionItem[] = [];

  if (pending > 0) {
    attention.push({
      severity: "warn",
      title: `${pending} content improvement${pending === 1 ? "" : "s"} waiting for approval`,
      detail:
        pending === 1
          ? "A site content change is proposed and waiting for you to approve before it can open a PR."
          : `${pending} site content changes are proposed and waiting for you to approve before they can open PRs.`,
      ask: `Review the ${pending} content improvement${pending === 1 ? "" : "s"} waiting for approval.`,
    });
  }

  if (hasPublishTarget === false) {
    attention.push({
      severity: "high",
      title: "No site to publish to yet",
      detail:
        "the content designer can draft content improvements, but there's no repo to open PRs against. Connect a GitHub repo (or, if you've connected more than one, pick a default repo) so it can open content PRs.",
      ask: "Connect my site repo so the content designer can open content PRs.",
    });
  }

  if (recoveredUnqueued > 0) {
    attention.push({
      severity: "warn",
      title: `${recoveredUnqueued} drafted content improvement${recoveredUnqueued === 1 ? "" : "s"} not queued for approval`,
      detail:
        recoveredUnqueued === 1
          ? "A recent run produced a draft, but it never became an approval card. Ask the content designer to rerun a full-site audit so the best current improvement can queue cleanly."
          : `${recoveredUnqueued} recent drafts never became approval cards. Ask the content designer to rerun a full-site audit so the best current improvements can queue cleanly.`,
      ask: "Run a fresh full-site content audit. Read the connected site repo and live product, review homepage, landing/product/pricing/help/docs pages, internal links, and blog gaps, then queue up to 5 PR-ready markdown/MDX improvements. Prioritize existing page improvements over new blog posts unless a blog post is clearly the highest-leverage move.",
    });
  }

  if (pending === 0 && recoveredUnqueued === 0 && hasPublishTarget !== false) {
    attention.push({
      severity: "warn",
      title: "Run a fresh full-site content audit",
      detail:
        "The current queue has no active approval-ready site improvements. A fresh run should inspect the whole content surface, not just old blog drafts.",
      ask: "Run a fresh full-site content audit. Read the connected site repo and live product, review homepage, landing/product/pricing/help/docs pages, internal links, and blog gaps, then propose up to 5 PR-ready markdown/MDX improvements. Prioritize existing page improvements over new blog posts unless a blog post is clearly the highest-leverage move.",
    });
  }

  if (lastRunAt && lastRunOutput && !/publish|recommendations/i.test(lastRunOutput)) {
    attention.push({
      severity: "warn",
      title: "Last run drafted nothing",
      detail:
        "The most recent run didn't produce a publishable content improvement — likely no clear site or keyword gap that week.",
      ask: "Audit the full site again and identify the highest-leverage page, post, or internal-link improvement.",
    });
  }

  return {
    kpis: {
      prs_opened: prsOpened,
      pending,
      drafted_last_30d: draftedLast30d,
      last_draft_at: lastDraftAt,
    },
    last_audit_at: lastRunAt,
    has_publish_target: hasPublishTarget,
    queue,
    attention,
  };
};
