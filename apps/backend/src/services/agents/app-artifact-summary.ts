
export type AppArtifactQaFinding = {
  title: string;
  detail?: string;
  severity?: "P0" | "P1" | "P2" | "P3" | "info";
};

export type AppArtifactSummaryInput = {
  company_name: string;
  idea?: string;
  repo_url?: string;
  github_full_name?: string;
  live_url?: string;
  default_branch?: string;
  routes?: string[];
  schema_summary?: string[];
  env_vars?: string[];
  known_limitations?: string[];
  qa_findings?: AppArtifactQaFinding[];
};

export type AppArtifactSummary = {
  title: string;
  body_markdown: string;
  tags: string[];
  metadata: Record<string, unknown>;
};

const MAX_LIST_ITEMS = 60;
const MAX_LINE_CHARS = 240;
const MAX_QA_FINDINGS = 40;

export const APP_ARTIFACT_TAG = "app_artifact";

function clampLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_LINE_CHARS) return t;
  return `${t.slice(0, MAX_LINE_CHARS - 1)}…`;
}

function cleanList(items: readonly string[] | undefined, cap = MAX_LIST_ITEMS): string[] {
  if (!items || items.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== "string") continue;
    const line = clampLine(raw);
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, info: 4 };
function orderedFindings(findings: readonly AppArtifactQaFinding[] | undefined): AppArtifactQaFinding[] {
  if (!findings || findings.length === 0) return [];
  const cleaned = findings
    .filter((f): f is AppArtifactQaFinding => !!f && typeof f.title === "string" && f.title.trim().length > 0)
    .slice(0, MAX_QA_FINDINGS);
  return [...cleaned]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const sa = SEVERITY_ORDER[a.f.severity ?? "info"] ?? 4;
      const sb = SEVERITY_ORDER[b.f.severity ?? "info"] ?? 4;
      return sa === sb ? a.i - b.i : sa - sb;
    })
    .map(({ f }) => f);
}

export function assembleAppArtifactSummary(input: AppArtifactSummaryInput): AppArtifactSummary {
  const company = clampLine(input.company_name) || "the app";
  const repoFull = input.github_full_name ? clampLine(input.github_full_name) : undefined;
  const repoUrl = input.repo_url ? clampLine(input.repo_url) : undefined;
  const liveUrl = input.live_url ? clampLine(input.live_url) : undefined;
  const branch = input.default_branch ? clampLine(input.default_branch) : undefined;
  const idea = input.idea ? clampLine(input.idea) : undefined;

  const routes = cleanList(input.routes);
  const schema = cleanList(input.schema_summary);
  const envVars = cleanList(input.env_vars);
  const limitations = cleanList(input.known_limitations);
  const findings = orderedFindings(input.qa_findings);

  const lines: string[] = [];
  lines.push(`# ${company} — built app`);
  lines.push("");
  lines.push(
    `The product-builder deployed **${company}**. This note is the app's day-zero ` +
      `artifact so the agent team knows what was built without re-discovering it.`,
  );

  if (idea) {
    lines.push("");
    lines.push("## What it is");
    lines.push(idea);
  }

  const coords: string[] = [];
  if (liveUrl) coords.push(`- **Live URL:** ${liveUrl}`);
  if (repoUrl) coords.push(`- **Repo:** ${repoUrl}`);
  else if (repoFull) coords.push(`- **Repo:** ${repoFull}`);
  if (repoFull && repoUrl) coords.push(`- **Repo (owner/name):** ${repoFull}`);
  if (branch) coords.push(`- **Default branch:** ${branch}`);
  if (coords.length > 0) {
    lines.push("");
    lines.push("## Where it lives");
    lines.push(...coords);
  }

  if (routes.length > 0) {
    lines.push("");
    lines.push("## Routes");
    lines.push(...routes.map((r) => `- \`${r}\``));
  }

  if (schema.length > 0) {
    lines.push("");
    lines.push("## DB schema");
    lines.push(...schema.map((s) => `- ${s}`));
  }

  if (envVars.length > 0) {
    lines.push("");
    lines.push("## Env vars (names only)");
    lines.push(...envVars.map((e) => `- \`${e}\``));
  }

  if (limitations.length > 0) {
    lines.push("");
    lines.push("## Known limitations");
    lines.push(...limitations.map((l) => `- ${l}`));
  }

  if (findings.length > 0) {
    lines.push("");
    lines.push("## QA ledger");
    for (const f of findings) {
      const sev = f.severity ? `**${f.severity}** — ` : "";
      const detail = f.detail ? `: ${clampLine(f.detail)}` : "";
      lines.push(`- ${sev}${clampLine(f.title)}${detail}`);
    }
  }

  const body_markdown = lines.join("\n");

  const tags = [APP_ARTIFACT_TAG];

  const metadata: Record<string, unknown> = {
    kind: "app_artifact",
    company_name: company,
  };
  if (repoFull) metadata.github_full_name = repoFull;
  if (repoUrl) metadata.repo_url = repoUrl;
  if (liveUrl) metadata.live_url = liveUrl;
  if (branch) metadata.default_branch = branch;
  metadata.route_count = routes.length;
  metadata.qa_finding_count = findings.length;

  return {
    title: `${company} — built app`,
    body_markdown,
    tags,
    metadata,
  };
}
