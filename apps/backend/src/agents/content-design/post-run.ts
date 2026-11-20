
import { createHash } from "crypto";
import type { PostProcessorFn } from "@/agents/index";
import { serviceClient } from "@/services/supabase";
import { getScopedRepoFullNames, type RepoReadOptions } from "@/services/connectors/github/scoped-repos";
import {
  realProvisionedRepoGateDeps,
  type ProvisionedRepoGateDeps,
} from "@/services/provisioning/provisioned-repo-gate";
import {
  assertReadRepoMembership,
  resolveInstallationId,
  readFileImpl,
} from "@/services/mcp/internal/github";
import {
  contentSeoRecommendationSchema,
  type ContentSeoRecommendation,
  type ContentSeoComponentCopyRecommendation,
  type ContentDecision,
  type EvidenceItem,
} from "./output-schema";
import { DECISION_CLASS, DECISION_CLASSES } from "./constants";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RECS_PER_RUN = 5;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type ParsedPublish = {
  change_type:
    | "new_blog_post"
    | "new_landing_page"
    | "improve_existing_page"
    | "refresh_existing_post"
    | "add_internal_links"
    | "component_copy";
  action: "create" | "modify";
  path: string;
  slug: string;
  title: string;
  meta_description: string;
  target_keyword?: string;
  body: string;
  rationale?: string;
  expected_impact?: string;
  user_need?: string;
  evidence?: EvidenceItem[];
  content_decision?: ContentDecision;
  hypothesis?: string;
  success_signal?: string;
  changes?: { before: string; after: string }[];
};

export type PublishTarget = { repo: string; defaultBranch: string };

export function parsePublishBlock(
  markdown: string,
): ParsedPublish | { error: string } | null {
  const anchor = markdown.search(/^[ \t]*Publish:[ \t]*$/m);
  if (anchor === -1) return null;

  let region = markdown.slice(anchor);
  const fenceIdx = region.indexOf("\n```");
  if (fenceIdx !== -1) region = region.slice(0, fenceIdx);

  const field = (label: string): string | null => {
    const m = region.match(new RegExp(`^[ \\t]*${label}:[ \\t]*(.+?)[ \\t]*$`, "m"));
    return m ? m[1].trim() : null;
  };

  const slug = field("Slug");
  const title = field("Title");
  const meta_description = field("Meta-Description");
  const target_keyword = field("Target-Keyword");

  const bodyMatch = region.match(/^[ \t]*Body:[ \t]*\n([\s\S]*)$/m);
  const body = bodyMatch ? bodyMatch[1].trim() : "";

  if (!slug) return { error: "missing Slug" };
  if (!SLUG_RE.test(slug)) {
    return { error: `invalid Slug '${slug}' (must be kebab-case, no slashes)` };
  }
  if (!title) return { error: "missing Title" };
  if (!meta_description) return { error: "missing Meta-Description" };
  if (!target_keyword) return { error: "missing Target-Keyword" };
  if (!body) return { error: "missing or empty Body" };

  return {
    change_type: "new_blog_post",
    action: "create",
    path: postPathForSlug(slug),
    slug,
    title,
    meta_description,
    target_keyword,
    body,
  };
}

export const MAX_BODY_WORDS = 1500;
export const MAX_BODY_CHARS = 12000;

export function checkBodyBudget(body: string): "body_over_budget" | "body_truncated" | null {
  const trimmed = body.trim();
  if (trimmed.length > MAX_BODY_CHARS) return "body_over_budget";
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (words > MAX_BODY_WORDS) return "body_over_budget";
  const fences = (trimmed.match(/```/g) ?? []).length;
  if (fences % 2 !== 0) return "body_truncated";
  const lastLineRaw = trimmed.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const listMatch = lastLineRaw.match(/^(?:[-*+]|\d+\.)(?:\s+(?:\[[ xX]\]\s*)?(.*))?$/);
  const content = listMatch ? (listMatch[1] ?? "").trim() : lastLineRaw;
  const endsClean =
    /^#{1,6}\s/.test(lastLineRaw) ||
    (content.length > 0 &&
      (/[.!?:)\]"'`*_>|]$/.test(content) ||
        !/\s/.test(content)));
  if (!endsClean) return "body_truncated";
  return null;
}

const SAFE_CONTENT_PATH_RE = /^[A-Za-z0-9._/-]+\.(md|mdx)$/;

function validateContentPath(path: string): string | { error: string } {
  const p = path.trim();
  if (!p) return { error: "missing path" };
  if (p.startsWith("/") || p.includes("..") || p.includes("//")) {
    return { error: `invalid path '${path}' (must be a safe repo-relative path)` };
  }
  if (!SAFE_CONTENT_PATH_RE.test(p)) {
    return { error: `invalid path '${path}' (must end in .md or .mdx)` };
  }
  return p;
}

const SAFE_COMPONENT_PATH_RE = /^[A-Za-z0-9._/-]+\.(ts|tsx|js|jsx)$/;

const COMPONENT_PATH_DENYLIST_RE =
  /auth|payment|stripe|webhook|middleware|session|billing|secret|vault|password|token/i;

export function validateComponentPath(path: string): string | { error: string } {
  const p = (path ?? "").trim();
  if (!p) return { error: "missing path" };
  if (p.startsWith("/") || p.includes("..") || p.includes("//")) {
    return { error: `invalid path '${path}' (must be a safe repo-relative path)` };
  }
  if (!SAFE_COMPONENT_PATH_RE.test(p)) {
    return { error: `invalid path '${path}' (must end in .ts/.tsx/.js/.jsx)` };
  }
  if (COMPONENT_PATH_DENYLIST_RE.test(p)) {
    return {
      error: `denylisted path '${p}' — the content agent may not edit money/auth/PII-adjacent code; needs engineer`,
    };
  }
  return p;
}

export function oldStringLooksLikeCode(s: string): boolean {
  if (/\b(import|export|function|const|let|return)\b/.test(s)) return true;
  if (/=>/.test(s)) return true;
  if (/\brequire\s*\(/.test(s)) return true;
  if (/`[^`]*\$\{/.test(s)) return true;
  if (/^\s*<\/?[A-Za-z]/.test(s)) return true;
  return false;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const next = haystack.indexOf(needle, idx);
    if (next === -1) break;
    count += 1;
    idx = next + needle.length;
  }
  return count;
}

export function buildComponentCopyParsed(
  rec: ContentSeoComponentCopyRecommendation,
  fileContent: string,
): { parsed: ParsedPublish } | { error: string } {
  const safe = validateComponentPath(rec.path);
  if (typeof safe !== "string") return { error: `component_copy: ${safe.error}` };

  if (!Array.isArray(rec.edits) || rec.edits.length === 0) {
    return { error: `component_copy ${safe}: no edits` };
  }

  type EditSpan = { start: number; end: number; replacement: string };
  const spans: EditSpan[] = [];
  for (const edit of rec.edits) {
    const oldStr = edit?.old_string ?? "";
    if (!oldStr) return { error: `component_copy ${safe}: empty old_string` };
    if (oldStringLooksLikeCode(oldStr)) {
      return {
        error: `component_copy ${safe}: old_string looks like code, not copy — needs engineer`,
      };
    }
    const newStr = edit?.new_string ?? "";
    if (newStr && oldStringLooksLikeCode(newStr)) {
      return {
        error: `component_copy ${safe}: new_string looks like code, not copy — needs engineer`,
      };
    }
    const n = countOccurrences(fileContent, oldStr);
    if (n !== 1) {
      return {
        error: `component_copy ${safe}: old_string not uniquely found (${n} matches) — needs engineer`,
      };
    }
    const start = fileContent.indexOf(oldStr);
    spans.push({ start, end: start + oldStr.length, replacement: newStr });
  }

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) {
      return {
        error: `component_copy ${safe}: edits overlap in the file — ambiguous, needs engineer`,
      };
    }
  }

  let working = "";
  let cursor = 0;
  for (const span of sorted) {
    working += fileContent.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  working += fileContent.slice(cursor);

  if (working === fileContent) {
    return { error: `component_copy ${safe}: edits produced no change` };
  }

  const decisionVerb: Record<string, string> = {
    reword: "Reword",
    restructure: "Restructure",
    remove: "Remove copy in",
    change_format: "Reformat",
    add_microcopy: "Add microcopy to",
    no_content: "Update",
  };
  const fileBase = (safe.split("/").pop() ?? "").replace(/\.(md|mdx|tsx?|jsx?)$/i, "");
  const title =
    (rec.title ?? "").trim() ||
    `${decisionVerb[rec.content_decision as string] ?? "Update"} ${fileBase}`.slice(0, 110);

  const changes = rec.edits.map((edit) => ({
    before: (edit?.old_string ?? "").trim(),
    after: (edit?.new_string ?? "").trim(),
  }));

  return {
    parsed: {
      change_type: "component_copy",
      action: "modify",
      path: safe,
      slug: slugFromPath(safe),
      title,
      meta_description: "",
      body: working,
      rationale: (rec.rationale ?? "").trim() || undefined,
      user_need: (rec.user_need ?? "").trim() || undefined,
      evidence: Array.isArray(rec.evidence) && rec.evidence.length ? rec.evidence : undefined,
      content_decision: rec.content_decision,
      hypothesis: (rec.hypothesis ?? "").trim() || undefined,
      success_signal: (rec.success_signal ?? "").trim() || undefined,
      changes: changes.length ? changes : undefined,
    },
  };
}

function slugFromPath(path: string): string {
  const file = path.split("/").pop() ?? "content-change";
  return file.replace(/\.(md|mdx|tsx?|jsx?)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "content-change";
}

function legacyChangeType(
  changeType: Exclude<ContentSeoRecommendation["change_type"], "code_content_edit">,
): ParsedPublish["change_type"] {
  return changeType === "new_page" ? "new_blog_post" : changeType;
}

function actionForChangeType(changeType: ParsedPublish["change_type"]): ParsedPublish["action"] {
  return changeType === "new_blog_post" || changeType === "new_landing_page"
    ? "create"
    : "modify";
}

export function recommendationToParsed(
  rec: unknown,
): ParsedPublish | { error: string } {
  if (!rec || typeof rec !== "object") return { error: "not an object" };
  const r = rec as Record<string, unknown>;
  if (r.change_type === "code_content_edit") {
    return { error: "code_content_edit is an engineer handoff, not a publish" };
  }
  if (
    r.change_type !== "new_page" &&
    r.change_type !== "new_blog_post" &&
    r.change_type !== "new_landing_page" &&
    r.change_type !== "improve_existing_page" &&
    r.change_type !== "refresh_existing_post" &&
    r.change_type !== "add_internal_links"
  ) {
    return { error: `unsupported change_type '${String(r.change_type)}'` };
  }
  const change_type = legacyChangeType(r.change_type);
  let slug = "";
  let path = "";

  if (change_type === "new_blog_post") {
    slug = str(r.slug).trim();
    if (!slug) return { error: "missing slug" };
    if (!SLUG_RE.test(slug)) {
      return { error: `invalid slug '${slug}' (must be kebab-case, no slashes)` };
    }
    path = postPathForSlug(slug);
  } else {
    const safePath = validateContentPath(str(r.path));
    if (typeof safePath !== "string") return safePath;
    path = safePath;
    slug = slugFromPath(path);
  }

  const title = str(r.title).trim();
  const meta_description = str(r.meta_description).trim();
  const target_keyword = str(r.target_keyword).trim();
  const body = str(r.body).trim();
  if (!title) return { error: "missing title" };
  if (!body) return { error: "missing or empty body" };
  const bodyCheck = checkBodyBudget(body);
  if (bodyCheck) return { error: bodyCheck };
  const cd = r as Partial<{
    user_need: string;
    evidence: EvidenceItem[];
    content_decision: ContentDecision;
    hypothesis: string;
    success_signal: string;
  }>;
  return {
    change_type,
    action: actionForChangeType(change_type),
    path,
    slug,
    title,
    meta_description,
    target_keyword: target_keyword || undefined,
    body,
    rationale: str(r.rationale).trim() || undefined,
    expected_impact: str(r.expected_impact).trim() || undefined,
    user_need: str(cd.user_need).trim() || undefined,
    evidence: Array.isArray(cd.evidence) && cd.evidence.length ? cd.evidence : undefined,
    content_decision: cd.content_decision,
    hypothesis: str(cd.hypothesis).trim() || undefined,
    success_signal: str(cd.success_signal).trim() || undefined,
  };
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildPostFileContent(p: {
  slug?: string;
  title: string;
  meta_description: string;
  target_keyword?: string;
  body: string;
}): string {
  const frontMatter = [
    "---",
    `title: ${yamlQuote(p.title)}`,
    `description: ${yamlQuote(p.meta_description)}`,
    `keyword: ${yamlQuote(p.target_keyword || p.title)}`,
    "---",
    "",
  ].join("\n");
  return `${frontMatter}${p.body}\n`;
}

export function postPathForSlug(slug: string): string {
  return `content/blog/${slug}.md`;
}

function fileContentForChange(p: ParsedPublish): string {
  if (p.change_type === "new_blog_post" || p.change_type === "new_landing_page") {
    return buildPostFileContent({
      ...p,
      meta_description: p.meta_description || p.title,
      target_keyword: p.target_keyword || p.title,
    });
  }
  if (p.change_type === "component_copy") return p.body;
  return `${p.body.trim()}\n`;
}

function changeTypeLabel(type: ParsedPublish["change_type"]): string {
  switch (type) {
    case "new_blog_post":
      return "new blog post";
    case "new_landing_page":
      return "new landing page";
    case "improve_existing_page":
      return "existing page improvement";
    case "refresh_existing_post":
      return "existing post refresh";
    case "add_internal_links":
      return "internal-link improvement";
    case "component_copy":
      return "in-product copy change";
  }
}

function changeVerb(type: ParsedPublish["change_type"]): string {
  switch (type) {
    case "new_blog_post":
      return "publish";
    case "new_landing_page":
      return "create";
    case "improve_existing_page":
      return "improve";
    case "refresh_existing_post":
      return "refresh";
    case "add_internal_links":
      return "add links to";
    case "component_copy":
      return "update";
  }
}

const CONTENT_DECISION_LABEL: Record<ContentDecision, string> = {
  reword: "reword for clarity",
  restructure: "restructure",
  remove: "remove content",
  change_format: "change the format",
  no_content: "no content (remove the copy)",
  add_microcopy: "add microcopy",
};

function buildRecommendationCard(p: ParsedPublish, path: string): string {
  if (p.change_type === "component_copy") {
    const lines = [
      `**Recommendation — in-product copy change**`,
      ``,
    ];
    if (p.user_need) lines.push(`**User need:** ${p.user_need}`);
    if (p.content_decision) {
      lines.push(`**Content decision:** ${CONTENT_DECISION_LABEL[p.content_decision]}`);
    }
    lines.push(`**Where:** \`${path}\` in your connected repo`);
    if (p.evidence && p.evidence.length) {
      lines.push(``, `**Evidence:**`);
      for (const e of p.evidence) lines.push(`- ${e.source}: ${e.detail}`);
    }
    if (p.success_signal) lines.push(``, `**Success signal:** ${p.success_signal}`);
    if (p.hypothesis) lines.push(`**Hypothesis:** ${p.hypothesis}`);
    lines.push(
      ``,
      `Approve to open a PR modifying this copy (you review + merge it on GitHub). Reject to skip.`,
    );
    return lines.join("\n");
  }

  const lines = [
    `**Recommendation — ${changeTypeLabel(p.change_type)}**`,
    ``,
  ];
  if (p.user_need) {
    lines.push(`**User need:** ${p.user_need}`);
    lines.push(`**What:** ${changeVerb(p.change_type)} content on the site`);
  } else if (p.target_keyword) {
    lines.push(`**What:** ${changeVerb(p.change_type)} content targeting **${p.target_keyword}**`);
  } else {
    lines.push(`**What:** ${changeVerb(p.change_type)} content on the site`);
  }
  lines.push(
    `**Where:** \`${path}\` in your connected repo`,
    `**Proposed title:** ${p.title}`,
  );
  if (p.content_decision) {
    lines.push(`**Content decision:** ${CONTENT_DECISION_LABEL[p.content_decision]}`);
  }
  if (p.evidence && p.evidence.length) {
    lines.push(`**Evidence:**`);
    for (const e of p.evidence) lines.push(`- ${e.source}: ${e.detail}`);
  }
  if (p.rationale) lines.push(`**Why:** ${p.rationale}`);
  if (p.success_signal) lines.push(`**Success signal:** ${p.success_signal}`);
  else if (p.expected_impact) lines.push(`**Expected impact:** ${p.expected_impact}`);
  lines.push(
    ``,
    `Approve to open a PR ${p.action === "create" ? "adding" : "modifying"} this content (you review + merge it on GitHub). Reject to skip.`,
  );
  return lines.join("\n");
}

export function buildPublishProposal(
  p: ParsedPublish,
  target: PublishTarget,
): Record<string, unknown> {
  const path = p.path || postPathForSlug(p.slug);
  const content = fileContentForChange(p);
  const shortHash = createHash("sha1")
    .update(`${p.change_type}\n${path}\n${p.title}\n${p.body}`)
    .digest("hex")
    .slice(0, 8);
  const branchToken = `${changeVerb(p.change_type)}-${slugFromPath(path)}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 70);
  const bodyTarget = p.target_keyword
    ? ` targeting **${p.target_keyword}**`
    : "";
  return {
    repo: target.repo,
    base_branch: target.defaultBranch,
    head_branch: `product-builder/content-design-${branchToken}-${shortHash}`.slice(0, 120),
    title: `content: ${changeVerb(p.change_type)} "${p.title}"`.slice(0, 120),
    body: `${p.action === "create" ? "Adds" : "Updates"} ${changeTypeLabel(p.change_type)}${bodyTarget}.\n\nFile: \`${path}\`.\n\nProposed by the content-design agent. Review the PR, then merge to publish.`,
    rendered_markdown: buildRecommendationCard(p, path),
    change_type: p.change_type,
    changes: p.changes,
    files: [{ path, action: p.action, content }],
  };
}

export async function resolveProvisionedRepoFullName(
  tenant_id: string,
  deps: ProvisionedRepoGateDeps = realProvisionedRepoGateDeps,
  options: RepoReadOptions = {},
): Promise<string | null> {
  let row: { mode: string; external_ref: Record<string, unknown> } | null;
  try {
    row = await deps.loadRepoResource(tenant_id);
  } catch (e) {
    if (options.throwOnReadError) throw e;
    console.warn(
      `[content-design post-run] tenant_resources(repo) read threw — skipping provisioned: ${(e as Error).message}`,
    );
    return null;
  }
  if (!row || row.mode !== "provisioned") return null;
  const full =
    typeof row.external_ref?.github_full_name === "string"
      ? (row.external_ref.github_full_name as string).trim()
      : "";
  return full || null;
}

export async function resolveConnectedRepoTarget(
  tenant_id: string,
  options: RepoReadOptions = {},
): Promise<PublishTarget | null> {
  try {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("repo_full_names, default_repo_full_name, repo_default_branches")
      .eq("tenant_id", tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? null) as {
      repo_full_names: string[] | null;
      default_repo_full_name: string | null;
      repo_default_branches: Record<string, string> | null;
    } | null;
    if (!row) return null;
    const connected = await getScopedRepoFullNames(tenant_id, undefined, options);
    let repo: string | null = null;
    const dflt = (row.default_repo_full_name ?? "").trim();
    if (dflt && connected.includes(dflt)) repo = dflt;
    else if (connected.length === 1) repo = connected[0];
    if (!repo) return null;
    const branches = row.repo_default_branches ?? {};
    const defaultBranch = (branches[repo] ?? "").trim() || "main";
    return { repo, defaultBranch };
  } catch (e) {
    if (options.throwOnReadError) throw e;
    console.warn(
      `[content-design post-run] connector_metadata(github) read threw — skipping connected: ${(e as Error).message}`,
    );
    return null;
  }
}

export async function resolveContentSeoPublishRepo(
  tenant_id: string,
  options: RepoReadOptions = {},
): Promise<PublishTarget | null> {
  const connected = await resolveConnectedRepoTarget(tenant_id, options);
  if (connected) return connected;
  const provisioned = await resolveProvisionedRepoFullName(tenant_id, undefined, options);
  if (provisioned) return { repo: provisioned, defaultBranch: "main" };
  return null;
}

async function openProposedPaths(
  tenant_id: string,
  repo: string,
): Promise<Set<string>> {
  try {
    const { data, error } = await serviceClient()
      .from("decisions")
      .select("body")
      .eq("tenant_id", tenant_id)
      .in("decision_class", [...DECISION_CLASSES])
      .eq("status", "proposed")
      .limit(200);
    if (error) throw error;
    const paths = new Set<string>();
    for (const r of (data ?? []) as Array<{ body: unknown }>) {
      const b = (r.body ?? {}) as { repo?: unknown; files?: unknown };
      if (typeof b.repo === "string" && b.repo !== repo) continue;
      if (Array.isArray(b.files)) {
        for (const f of b.files as Array<{ path?: unknown }>) {
          if (typeof f.path === "string") paths.add(f.path);
        }
      }
    }
    return paths;
  } catch (e) {
    console.warn(
      `[content-design post-run] open-proposed-paths read threw (dedupe skipped): ${(e as Error).message}`,
    );
    return new Set();
  }
}

function normalizeStructuredRecommendations(
  recs: unknown[],
): { recs: ParsedPublish[]; parseError?: string } {
  const out: ParsedPublish[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const rec of recs.slice(0, MAX_RECS_PER_RUN)) {
    const norm = recommendationToParsed(rec);
    if ("error" in norm) {
      errors.push(norm.error);
      continue;
    }
    if (seen.has(norm.slug)) continue;
    seen.add(norm.slug);
    out.push(norm);
  }
  return { recs: out, parseError: errors.length ? errors.join("; ") : undefined };
}

function parseRecommendationJson(raw: string): ContentSeoRecommendation[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const maybe = (parsed as { recommendations?: unknown }).recommendations;
  if (!Array.isArray(maybe)) return null;
  const out: ContentSeoRecommendation[] = [];
  for (const item of maybe) {
    const r = contentSeoRecommendationSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out.length > 0 ? out : null;
}

export function extractFencedJsonRecommendations(markdown: string): ContentSeoRecommendation[] {
  const out: ContentSeoRecommendation[] = [];
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/gi;
  for (const match of markdown.matchAll(fenced)) {
    const body = match[1]?.trim();
    if (!body || !/"recommendations"\s*:/.test(body)) continue;
    const recs = parseRecommendationJson(body);
    if (recs) out.push(...recs);
  }
  return out;
}

function collectRawRecommendations(
  result: { parsed?: unknown; output_text?: string },
): ContentSeoRecommendation[] {
  const parsed = result.parsed as
    | { rendered_markdown?: unknown; recommendations?: unknown[] }
    | undefined;
  if (parsed?.recommendations && parsed.recommendations.length > 0) {
    const out: ContentSeoRecommendation[] = [];
    for (const item of parsed.recommendations) {
      const r = contentSeoRecommendationSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    if (out.length > 0) return out;
  }
  const rendered =
    typeof parsed?.rendered_markdown === "string" ? parsed.rendered_markdown : "";
  const raw = result.output_text ?? "";
  return extractFencedJsonRecommendations(`${rendered}\n${raw}`);
}

export function collectComponentCopyRecommendations(
  result: { parsed?: unknown; output_text?: string },
): ContentSeoComponentCopyRecommendation[] {
  return collectRawRecommendations(result)
    .filter(
      (r): r is ContentSeoComponentCopyRecommendation =>
        r.change_type === "component_copy",
    )
    .slice(0, MAX_RECS_PER_RUN);
}

export function collectRecommendations(
  result: { parsed?: unknown; output_text?: string },
): { recs: ParsedPublish[]; parseError?: string } {
  const raw = collectRawRecommendations(result);
  if (raw.length > 0) {
    const markdownRecs = raw.filter((r) => r.change_type !== "component_copy");
    const normalized = normalizeStructuredRecommendations(markdownRecs);
    const structuredCount = Array.isArray(
      (result.parsed as { recommendations?: unknown[] } | undefined)?.recommendations,
    )
      ? (result.parsed as { recommendations: unknown[] }).recommendations.length
      : 0;
    if (structuredCount > raw.length && !normalized.parseError) {
      return {
        ...normalized,
        parseError: `dropped ${structuredCount - raw.length} malformed recommendation(s)`,
      };
    }
    return normalized;
  }

  const parsed = result.parsed as { rendered_markdown?: unknown } | undefined;
  const rendered =
    typeof parsed?.rendered_markdown === "string" ? parsed.rendered_markdown : "";
  const markdown = rendered || (result.output_text ?? "");
  let block: ReturnType<typeof parsePublishBlock>;
  try {
    block = parsePublishBlock(markdown);
  } catch (e) {
    return { recs: [], parseError: `parse threw: ${(e as Error).message}` };
  }
  if (block === null) return { recs: [] };
  if ("error" in block) return { recs: [], parseError: `publish_block:${block.error}` };
  return { recs: [block] };
}

async function readComponentFileContent(
  tenant_id: string,
  target: PublishTarget,
  path: string,
): Promise<string | { error: string }> {
  const [owner, repoName] = target.repo.split("/");
  if (!owner || !repoName) {
    return { error: `cannot resolve owner/repo from '${target.repo}'` };
  }
  try {
    await assertReadRepoMembership(tenant_id, owner, repoName);
    const installation_id = await resolveInstallationId(tenant_id);
    const read = await readFileImpl(tenant_id, installation_id, {
      owner,
      repo: repoName,
      ref: target.defaultBranch,
      path,
    });
    if (read.truncated) {
      return { error: `file '${path}' exceeds the read cap (truncated) — needs engineer` };
    }
    return read.content;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const contentSeoPostProcess: PostProcessorFn = async (ctx, result) => {
  if (!result.parse_ok || !result.parsed) return;

  const { recs, parseError } = collectRecommendations(result);
  const componentRecs = collectComponentCopyRecommendations(result);
  const noteError = (msg: string) => {
    result.parse_error = result.parse_error ? `${result.parse_error}; ${msg}` : msg;
  };
  if (parseError) noteError(parseError);

  if (recs.length === 0 && componentRecs.length === 0) {
    console.log("[content-design post-run] no recommendation — no decision emitted");
    return;
  }

  const target = await resolveContentSeoPublishRepo(ctx.tenant_id);
  if (!target) {
    console.log(
      "[content-design post-run] no connected or provisioned repo — publish skipped (draft preserved in chat)",
    );
    return;
  }

  const alreadyOpen = await openProposedPaths(ctx.tenant_id, target.repo);
  const seenPaths = new Set<string>();

  const emitProposal = async (
    rec: ParsedPublish,
    proposal: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const decisionId = await ctx.emitDecision(DECISION_CLASS, proposal);
      console.log(
        `[content-design post-run] emitted decision ${decisionId} class=${DECISION_CLASS} type=${rec.change_type} slug=${rec.slug} repo=${target.repo}`,
      );
      return true;
    } catch (e) {
      console.warn(
        `[content-design post-run] emit_decision failed (slug=${rec.slug}): ${(e as Error).message}`,
      );
      return false;
    }
  };

  let emitted = 0;

  for (const rec of recs) {
    const path = rec.path;
    if (alreadyOpen.has(path) || seenPaths.has(path)) {
      console.log(
        `[content-design post-run] skip ${path} — already has an open/just-emitted proposed decision`,
      );
      continue;
    }
    seenPaths.add(path);
    if (await emitProposal(rec, buildPublishProposal(rec, target))) emitted += 1;
  }

  for (const rec of componentRecs) {
    const safe = validateComponentPath(rec.path);
    if (typeof safe !== "string") {
      noteError(`component_copy: ${safe.error}`);
      continue;
    }
    if (alreadyOpen.has(safe) || seenPaths.has(safe)) {
      console.log(
        `[content-design post-run] skip component_copy ${safe} — already has an open/just-emitted proposed decision`,
      );
      continue;
    }
    const fileContent = await readComponentFileContent(ctx.tenant_id, target, safe);
    if (typeof fileContent !== "string") {
      noteError(`component_copy ${safe}: could not read base file (${fileContent.error}) — needs engineer`);
      continue;
    }
    const built = buildComponentCopyParsed(rec, fileContent);
    if ("error" in built) {
      noteError(built.error);
      continue;
    }
    seenPaths.add(safe);
    if (await emitProposal(built.parsed, buildPublishProposal(built.parsed, target))) {
      emitted += 1;
    }
  }

  console.log(
    `[content-design post-run] emitted ${emitted}/${recs.length + componentRecs.length} recommendation decision(s) repo=${target.repo} branch=${target.defaultBranch}`,
  );
};
