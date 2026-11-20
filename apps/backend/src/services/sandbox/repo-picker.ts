
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER, MODELS } from "@/services/llm/models";
import {
  readReadyProfiles,
  readTenantDefaultRepo,
  type RepoProfile,
  type RepoKind,
} from "@/services/sandbox/repo-profiles";

const HAIKU_MODEL = MODELS.anthropic.haiku;
const MAX_TOKENS = 600;

export type RepoPickerDecision =
  | { decision: "pick"; repo: string }
  | { decision: "ask"; message: string };

export function renderRepoOptions(repos: readonly string[]): string {
  return repos
    .map((r, i) => `${String.fromCharCode(65 + i)}) \`${r}\``)
    .join("\n");
}

function fallbackAsk(repos: readonly string[]): string {
  return [
    "Which repo should I work in? Reply with the letter or the full `owner/name`.",
    "",
    renderRepoOptions(repos),
  ].join("\n");
}

type TaskPlatform = RepoKind | null;

function kindsOf(p: RepoProfile): RepoKind[] {
  return Array.isArray(p.kinds) && p.kinds.length > 0 ? p.kinds : [p.kind];
}

export function classifyTaskPlatform(text: string): TaskPlatform {
  const lower = text.toLowerCase();
  const iosRe = /\bios\b|swiftui|uikit|xcode|\.swift\b|\bipad\b|\biphone\b|\bcocoapods?\b|\bapp ?store\b/;
  const androidRe = /\bandroid\b|kotlin|jetpack|\bcompose\b|gradle|\.kt\b|play ?store/;
  const webRe = /\bweb\b|\bfrontend\b|\bnext\.?js\b|\breact\b|\bweb app\b|\bweb-app\b|\bwebsite\b|\bdashboard\b|\blanding page\b|\bhomepage\b/;
  const backendRe = /\bbackend\b|\bapi\b|\bserver\b|\bdatabase\b|\bmigration\b|\bendpoint\b|\bcron\b|\bworker\b/;

  const flags: Array<[RepoKind, boolean]> = [
    ["ios", iosRe.test(lower)],
    ["android", androidRe.test(lower)],
    ["web", webRe.test(lower)],
    ["backend", backendRe.test(lower)],
  ];
  const matched = flags.filter(([, v]) => v).map(([k]) => k);
  return matched.length === 1 ? matched[0] : null;
}

function deterministicProfilePick(
  taskText: string,
  profiles: readonly RepoProfile[],
): string | null {
  const platform = classifyTaskPlatform(taskText);
  if (!platform) return null;
  const matches = profiles.filter((p) => kindsOf(p).includes(platform));
  return matches.length === 1 ? matches[0].repo_full_name : null;
}

const GENERIC_REPO_NAMES = new Set([
  "admin", "android", "api", "app", "apps", "backend", "client", "core",
  "dashboard", "docs", "frontend", "ios", "lib", "main", "mobile", "packages",
  "server", "service", "services", "site", "src", "test", "tests", "web",
  "website", "worker", "workers", "www",
]);

export function repoNamedInTask(
  taskText: string,
  repos: readonly string[],
): string | null {
  const lower = taskText.toLowerCase();
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edge = "[^a-z0-9_./-]";

  const byLength = [...repos].sort(
    (a, b) => (b.split("/")[1] ?? b).length - (a.split("/")[1] ?? a).length,
  );

  const qualifiedEdge = "[^a-z0-9_.-]";
  const qualified = new Set<string>();
  for (const full of byLength) {
    const re = new RegExp(
      `(^|${qualifiedEdge})${esc(full.toLowerCase())}(${qualifiedEdge}|$)`,
      "i",
    );
    if (re.test(lower)) qualified.add(full);
  }
  if (qualified.size === 1) return Array.from(qualified)[0];
  if (qualified.size > 1) return null;

  const hits = new Set<string>();
  for (const full of byLength) {
    const bare = (full.split("/")[1] ?? full).toLowerCase();
    if (bare.length < 4) continue;
    if (GENERIC_REPO_NAMES.has(bare)) continue;
    const re = new RegExp(`(^|${edge})${esc(bare)}(${edge}|$)`, "i");
    if (re.test(lower)) hits.add(full);
  }
  return hits.size === 1 ? Array.from(hits)[0] : null;
}

function renderProfileCards(profiles: readonly RepoProfile[]): string {
  return profiles
    .map((p, i) => {
      const langs = Object.entries(p.language_stats)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([l]) => l)
        .join(", ");
      const parts = [
        `${String.fromCharCode(65 + i)}) \`${p.repo_full_name}\``,
        `   kind: ${kindsOf(p).join(", ")}`,
        langs ? `   languages: ${langs}` : "",
        p.frameworks.length ? `   frameworks: ${p.frameworks.join(", ")}` : "",
        p.topics.length ? `   topics: ${p.topics.slice(0, 6).join(", ")}` : "",
        p.description ? `   description: ${p.description.slice(0, 160)}` : "",
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n\n");
}

export async function pickRepoForTask(args: {
  task_description: string;
  repos: readonly string[];
  file_hints?: readonly string[];
  tenant_id?: string;
}): Promise<RepoPickerDecision> {
  const { task_description, repos, file_hints, tenant_id } = args;
  if (repos.length === 0) {
    return { decision: "ask", message: fallbackAsk(repos) };
  }
  if (repos.length === 1) {
    return { decision: "pick", repo: repos[0] };
  }

  const taskText = [task_description, ...(file_hints ?? [])].join(" ");

  let profiles: RepoProfile[] = [];
  if (tenant_id) {
    try {
      profiles = await readReadyProfiles({ tenant_id, repos });
    } catch {
      profiles = [];
    }
  }

  if (profiles.length >= 2) {
    const det = deterministicProfilePick(taskText, profiles);
    if (det) return { decision: "pick", repo: det };
  }

  const named = repoNamedInTask(task_description, repos);
  if (named) return { decision: "pick", repo: named };

  if (tenant_id) {
    try {
      const tenantDefault = await readTenantDefaultRepo(tenant_id);
      if (tenantDefault && repos.includes(tenantDefault)) {
        return { decision: "pick", repo: tenantDefault };
      }
    } catch {
    }
  }

  const haveCards =
    profiles.length >= 2 && profiles.length === repos.length;
  const optionsBlock = haveCards
    ? renderProfileCards(profiles)
    : renderRepoOptions(repos);

  const system = [
    "You route coding tasks to the right GitHub repository.",
    "",
    "You receive (1) a task description from an operator and (2) a list of",
    "the operator's connected repositories" +
      (haveCards ? " WITH a structured profile for each" : "") +
      ".",
    "",
    "Decide one of:",
    `  - "pick": the task obviously belongs to exactly one repo. Use the repo`,
    "    profile (kind: ios/android/web/backend, languages, frameworks, topics,",
    "    description) to match the task's intent. Return that repo's full name",
    "    verbatim.",
    `  - "ask": the task is genuinely ambiguous across two or more repos, or no`,
    "    repo clearly matches. Return a short markdown message asking the",
    "    operator which repo, listing the options with their A/B/C/D labels and",
    "    a 1-line hint per repo from its profile.",
    "",
    "Output strict JSON only, no prose around it. Schemas:",
    '  pick: {"decision":"pick","repo":"owner/name"}',
    '  ask:  {"decision":"ask","message":"<markdown>"}',
    "",
    "Match by MEANING from the profile, NOT by repo name. A task about the",
    "mobile app routes to the repo whose kind is ios or android; a dashboard /",
    "website / frontend task routes to a web-kind repo; an API / server / DB /",
    "migration task routes to a backend-kind repo. When two repos share the same",
    "kind (e.g. two web repos) and the task doesn't distinguish them, ASK.",
    "",
    "Never invent a repo name not in the provided list.",
  ].join("\n");

  const user = [
    "Task:",
    task_description.slice(0, 2000),
    "",
    haveCards ? "Connected repos (with profiles):" : "Connected repos:",
    optionsBlock,
  ].join("\n");

  try {
    const resp = await callModel({
      provider: DEFAULT_PROVIDER,
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.text.trim() || "";
    const parsed = extractJsonObject(text);
    if (!parsed) {
      return { decision: "ask", message: fallbackAsk(repos) };
    }

    if (
      parsed.decision === "pick" &&
      typeof parsed.repo === "string" &&
      repos.includes(parsed.repo)
    ) {
      return { decision: "pick", repo: parsed.repo };
    }
    if (
      parsed.decision === "ask" &&
      typeof parsed.message === "string" &&
      parsed.message.trim().length > 0
    ) {
      return { decision: "ask", message: parsed.message };
    }
    return { decision: "ask", message: fallbackAsk(repos) };
  } catch {
    return { decision: "ask", message: fallbackAsk(repos) };
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
  const candidate = fenced ? fenced[1] : firstJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseRepoPickReply(
  body: string,
  repos: readonly string[],
): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;

  const letterMatch = trimmed.match(
    /^(?:option\s+)?\(?\*{0,2}([A-Za-z])\*{0,2}(?:\s*$|[).:](?:\s|$)|\s+[-–]\s+)/i,
  );
  if (letterMatch) {
    const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < repos.length) return repos[idx];
  }

  for (const repo of repos) {
    if (trimmed.includes(repo)) return repo;
  }

  const bareMatches = repos.filter((r) => {
    const name = r.split("/")[1] ?? "";
    return name.length > 0 && trimmed.toLowerCase().includes(name.toLowerCase());
  });
  if (bareMatches.length === 1) return bareMatches[0];

  return null;
}
