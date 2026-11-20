
import { getChannel } from "@zavi/shared";
import type { RunOutcome } from "./outcome-model";
import { hasInternalJargon } from "./internal-jargon";

export type RunStatusState = "working" | "done" | "needs_input" | "couldnt";

export type RunStatusLink = {
  kind: "pr" | "preview" | "run";
  url: string;
  label: string;
};

export type RunStatusNext = "pick_repo" | "reply" | "retry";

export type RunStatus = {
  state: RunStatusState;
  title: string;
  links: RunStatusLink[];
  next?: RunStatusNext;
  summary: string | null;
  text_fallback: string;
  summary_first?: true;
};

export type ProjectableRun = {
  id: string;
  agent_slug?: string | null;
  status: string | null;
  outcome?: Partial<RunOutcome> | null;
  parsed?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  output_text?: string | null;
};

export const STATUS_PHRASES = {
  wrong_repo: "I couldn't work in the right repo. Which one should I use?",
  needs_input: "I need a little more from you before I can do this.",
  blocked: "I couldn't make this change.",
  no_change: "No changes were made.",
  couldnt: "This didn't finish. Nothing was saved. I can try again.",
  change_ready: "The change is ready.",
  answered: "Answered.",
  finished: "Finished.",
  working: "Working on it.",
  waiting_on_agent: "Waiting on another agent's answer.",
} as const;

const WORKING_STATUSES = new Set(["queued", "running", "pending", ""]);
const PR_URL_RE = /^https?:\/\/(?:github|gitlab)\.com\/[^\s)]+\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const TITLE_MAX = 120;

type PrRef = { url: string; number: number | null; title: string | null };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function resolvePr(run: ProjectableRun): PrRef | null {
  if (run.outcome?.side_effect?.kind !== "shipped") return null;
  const parsed = run.parsed ?? null;
  const title = str(parsed?.title);
  const fromParsed = str(parsed?.pr_url);
  const url: string | null = fromParsed && PR_URL_RE.test(fromParsed) ? fromParsed : null;
  if (!url) return null;
  const declared = parsed?.pr_number;
  const number =
    typeof declared === "number" && Number.isInteger(declared) && declared > 0
      ? declared
      : Number(url.match(PR_URL_RE)?.[1] ?? NaN) || null;
  return { url, number, title: title ? title.slice(0, TITLE_MAX) : null };
}

export function customerSummaryOf(run: ProjectableRun): string | null {
  const outcome = run.outcome ?? null;
  const declared = str(outcome?.customer_summary);
  if (declared && !hasInternalJargon(declared)) return declared;
  const deliverable = outcome ? str(outcome.deliverable) : str(run.output_text);
  if (deliverable && !hasInternalJargon(deliverable)) return deliverable;
  return null;
}

function isNonSuccess(run: ProjectableRun): boolean {
  const s = (run.status ?? "").toLowerCase();
  if (s === "success") return false;
  const outcome = run.outcome ?? null;
  if (outcome?.failure?.class === "none" && str(outcome.deliverable)) return false;
  return true;
}

function ownStatus(run: ProjectableRun): Omit<RunStatus, "text_fallback"> {
  const status = (run.status ?? "").toLowerCase();
  const sideEffect = run.outcome?.side_effect ?? null;

  if (WORKING_STATUSES.has(status)) {
    const repo = str(run.payload?.repo_hint);
    return {
      state: "working",
      title: repo && REPO_RE.test(repo) ? `Working on it in ${repo}.` : STATUS_PHRASES.working,
      links: [],
      summary: null,
    };
  }

  if (status === "cancelled") {
    return { state: "couldnt", title: STATUS_PHRASES.couldnt, links: [], next: "retry", summary: null };
  }

  if (status === "paused_awaiting_child") {
    return { state: "working", title: STATUS_PHRASES.waiting_on_agent, links: [], summary: null };
  }

  const summary = customerSummaryOf(run);

  const pr = resolvePr(run);
  if (pr) {
    const ref = pr.number ? `PR #${pr.number}` : "a PR";
    return {
      state: "done",
      title: pr.title ? `Opened ${ref}: ${pr.title}` : `Opened ${ref}`,
      links: [{ kind: "pr", url: pr.url, label: pr.number ? `PR #${pr.number}` : "Pull request" }],
      summary,
    };
  }

  if (sideEffect?.kind === "refused" && sideEffect.reason_code) {
    switch (sideEffect.reason_code) {
      case "wrong_repo":
        return { state: "needs_input", title: STATUS_PHRASES.wrong_repo, links: [], next: "pick_repo", summary };
      case "needs_input":
        return { state: "needs_input", title: STATUS_PHRASES.needs_input, links: [], next: "reply", summary };
      case "blocked":
        return { state: "couldnt", title: STATUS_PHRASES.blocked, links: [], next: "reply", summary };
      case "no_change":
        return { state: "done", title: STATUS_PHRASES.no_change, links: [], summary, summary_first: true };
    }
  }

  if (isNonSuccess(run)) {
    return { state: "couldnt", title: STATUS_PHRASES.couldnt, links: [], next: "retry", summary };
  }

  if (sideEffect?.kind === "refused") {
    return { state: "done", title: STATUS_PHRASES.no_change, links: [], summary };
  }

  if (sideEffect?.kind === "shipped") {
    const channel = getChannel(run.agent_slug ?? "");
    if (channel) {
      const title = `I added the next steps to your ${channel.name} channel in Zavi.`;
      return { state: "done", title, links: [], summary, summary_first: true };
    }
    return { state: "done", title: STATUS_PHRASES.change_ready, links: [], summary };
  }

  return { state: "done", title: summary ? STATUS_PHRASES.answered : STATUS_PHRASES.finished, links: [], summary };
}

function textFallback(title: string, links: RunStatusLink[]): string {
  const urls = links.map((l) => l.url);
  return urls.length > 0 ? `${title}\n${urls.join("\n")}` : title;
}

export function projectRunStatus(
  run: ProjectableRun,
  children: readonly ProjectableRun[] = [],
): RunStatus {
  const own = ownStatus(run);
  const childStatuses = children.filter((c) => c && c.id !== run.id).map(ownStatus);

  let { state, title } = own;
  const links = [...own.links];
  for (const c of childStatuses) {
    for (const l of c.links) {
      if (!links.some((x) => x.url === l.url)) links.push(l);
    }
  }
  if (state !== "working" && childStatuses.some((c) => c.state === "working")) {
    state = "working";
    title = STATUS_PHRASES.working;
  }

  const status: RunStatus = {
    state,
    title,
    links,
    summary: state === "working" ? null : own.summary,
    text_fallback: textFallback(title, links),
  };
  if (own.next && state !== "working") status.next = own.next;
  if (own.summary_first && state !== "working") status.summary_first = true;
  return status;
}

export function composeCustomerStatusBody(status: RunStatus): string {
  const summary = status.summary?.trim();
  if (!summary || summary === status.title) return status.text_fallback;
  if (status.title === STATUS_PHRASES.answered) return [summary, ...status.links.map((l) => l.url)].join("\n");
  if (status.summary_first) return `${summary}\n\n${status.text_fallback}`;
  return `${status.text_fallback}\n\n${summary}`;
}

export function unionChildRuns<T extends { id: string }>(
  a: readonly T[],
  b: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...a, ...b]) {
    if (!r || typeof r.id !== "string" || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
