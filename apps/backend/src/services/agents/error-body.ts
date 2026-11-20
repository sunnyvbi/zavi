
const BODY_CAP = 8000;

import { scrubAgentEgress } from "./scrub-agent-egress";
import { isProviderUsageLimitError, isUsageLimitError } from "./infra-retry";
import { isOurSeatAuthError } from "./seat-auth-error";
import { assistantSafeRunError } from "@/services/mcp/assistant-policy";
import { parseUsageLimit } from "./usage-limit-alert";
import { parseModelRefusal } from "./sdk-refusal";

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; redactedShape: string }> = [
  {
    re: /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
    redactedShape: "Bearer <redacted>",
  },
  {
    re: /\b(sk_(?:live|test)_)[A-Za-z0-9]{8,}/g,
    redactedShape: "$1<redacted>",
  },
  {
    re: /\b(pk_(?:live|test)_)[A-Za-z0-9]{8,}/g,
    redactedShape: "$1<redacted>",
  },
  {
    re: /\b(xoxb-)[A-Za-z0-9-]{8,}/g,
    redactedShape: "$1<redacted>",
  },
  {
    re: /\b(xoxp-)[A-Za-z0-9-]{8,}/g,
    redactedShape: "$1<redacted>",
  },
  {
    re: /\b([A-Z][A-Z0-9_]{4,})=[A-Za-z0-9._\-+/=]{12,}/g,
    redactedShape: "$1=<redacted>",
  },
];

export function sanitizeErrorString(raw: string): string {
  let out = raw;
  for (const { re, redactedShape } of SECRET_PATTERNS) {
    out = out.replace(re, redactedShape);
  }
  return out;
}

const CONNECT_RE = /\b([a-z][a-z0-9_]*?)_not_connected\b/;
const AUTH_EXPIRED_RE = /\b([a-z][a-z0-9_]*?)_auth_expired\b/;

const REPO_ACCESS_RE = /^resolve-repo-creds:/;

const REPO_NONE_SELECTED_RE = /no repositories are selected|no repos are accessible/i;
const REPO_NOT_INSTALLED_RE = /App not connected/i;
const REPO_BAD_TARGET_RE = /must be 'owner\/name'/i;

const GITHUB_INSTALL_DEAD_404_RE =
  /\b(mintInstallationToken|getInstallation|listInstallationRepos|downloadRepoTarballBase64)\s+HTTP\s*404\b/;
const GITHUB_INSTALL_AUTH_401_RE =
  /\b(mintInstallationToken|getInstallation|listInstallationRepos|downloadRepoTarballBase64)\s+HTTP\s*401\b/;

const INFRA_REAP_RE = /^(boot_reap|watchdog_reap)\b/;
const INFRA_REAP_PHRASE_RE = /orphaned by container restart/i;

const STALE_REAP_RE = /^stale_reap\b/;

const INNGEST_UNREACHABLE_RE = /\bhttp_unreachable\b/i;
const INNGEST_EXHAUSTED_RE = /exhausted retries/i;

const WORKTREE_SETUP_RE = /\bworktree_timeout\b|per-run worktree create failed/i;

const WORKTREE_DISK_RE = /\bworktree_insufficient_disk\b/i;

const WORKTREE_MISSING_BASE_RE = /not a valid object name|couldn't find remote ref/i;
const WORKTREE_EMPTY_REPO_RE = /not a valid object name/i;

const RATE_LIMIT_RE = /\b(HTTP\s*429|secondary[- ]rate[- ]limit|rate[_-]?limit|Retry-After|too many requests)\b/i;
const TRANSIENT_RE = /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error)\b/i;

function titleCaseSlug(slug: string): string {
  return slug
    .split("_")
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ");
}

export const SEAT_FAILURE_BODY =
  "I couldn't reach the AI service that powers me. There's a temporary " +
  "account issue on our side, not a problem with your request. I've " +
  "logged the details; please try again in a little while.";

export const GENERIC_FAILURE_BODY =
  "Something failed while I was working on this and I couldn't finish it. " +
  "This is on my end, not a problem with your request — I've logged the " +
  "details. Please try again in a few minutes.";

const PROVIDER_OVERLOAD_RE = /\boverloaded_error\b|\bapi error:\s*5\d\d\b/i;

export type ErrorBodyResult = {
  markdown: string;
  action_link: string | null;
};

export function synthesizeErrorBody(
  rawError: string,
  agent_slug: string,
): ErrorBodyResult {
  const sanitized = scrubAgentEgress(sanitizeErrorString(rawError), {
    surface: "error",
    agentSlug: agent_slug,
  }).text;

  let action_link: string | null = null;
  let trailer: string;
  let opener: string | null = "Something failed while I was working on this:";

  const refusal = parseModelRefusal(rawError);
  if (refusal) {
    return { markdown: refusal, action_link: null };
  }

  if (isOurSeatAuthError(rawError)) {
    return { markdown: SEAT_FAILURE_BODY, action_link: null };
  }

  if (INFRA_REAP_RE.test(rawError) || INFRA_REAP_PHRASE_RE.test(rawError)) {
    const reapMarkdown =
      "I hit a temporary infrastructure hiccup and lost this run — please " +
      "re-send your message and I'll pick it up fresh.";
    return {
      markdown:
        reapMarkdown.length > BODY_CAP ? reapMarkdown.slice(0, BODY_CAP) : reapMarkdown,
      action_link: null,
    };
  }

  if (STALE_REAP_RE.test(rawError)) {
    const staleMarkdown = "I hit a temporary hiccup — try again in a moment.";
    return {
      markdown:
        staleMarkdown.length > BODY_CAP ? staleMarkdown.slice(0, BODY_CAP) : staleMarkdown,
      action_link: null,
    };
  }

  if (INNGEST_UNREACHABLE_RE.test(rawError) || INNGEST_EXHAUSTED_RE.test(rawError)) {
    const inngestMarkdown = "I hit a temporary hiccup — try again in a moment.";
    return {
      markdown:
        inngestMarkdown.length > BODY_CAP ? inngestMarkdown.slice(0, BODY_CAP) : inngestMarkdown,
      action_link: null,
    };
  }

  if (REPO_ACCESS_RE.test(rawError)) {
    const repoAccessMarkdown = REPO_NONE_SELECTED_RE.test(rawError)
      ? "GitHub is connected but no repositories are shared with Zavi. Grant repo " +
        "access in Settings → Connectors, then retry."
      : REPO_NOT_INSTALLED_RE.test(rawError)
        ? "GitHub isn't connected to Zavi yet, so I can't reach your repository. " +
          "Connect GitHub under Settings → Connectors, then re-run."
        : REPO_BAD_TARGET_RE.test(rawError)
          ? "I couldn't tell which repository to work in — the target needs to look " +
            "like `owner/name`. Tell me the repo and I'll re-run."
          : "I couldn't set up access to your repository for this run. This is a " +
            "problem on my end, not with your request — I've logged the details. " +
            "Please try again in a few minutes.";
    const connectAction = REPO_NOT_INSTALLED_RE.test(rawError)
      ? "[Connect GitHub](/__praxis_action__/connect:github)"
      : null;
    const withAction = connectAction
      ? `${repoAccessMarkdown}\n\n${connectAction}`
      : repoAccessMarkdown;
    return {
      markdown: withAction.length > BODY_CAP ? withAction.slice(0, BODY_CAP) : withAction,
      action_link: connectAction,
    };
  }

  if (GITHUB_INSTALL_AUTH_401_RE.test(rawError)) {
    const ghAction = "[Reconnect GitHub](/__praxis_action__/reauth:github)";
    const ghMarkdown = [
      "GitHub declined my authentication — this looks like a temporary credential issue on my side, not a problem with your repository.",
      "",
      "Give it a minute and re-send your message. If it keeps happening, reconnect the GitHub App in **Settings → Connectors → GitHub**.",
      "",
      ghAction,
    ].join("\n");
    return {
      markdown: ghMarkdown.length > BODY_CAP ? ghMarkdown.slice(0, BODY_CAP) : ghMarkdown,
      action_link: ghAction,
    };
  }

  if (GITHUB_INSTALL_DEAD_404_RE.test(rawError)) {
    const ghAction = "[Reconnect GitHub](/__praxis_action__/reauth:github)";
    const ghMarkdown = [
      "I couldn't reach your GitHub repository — the Zavi GitHub App was uninstalled or replaced on your account, so I can't open or fix anything until it's reconnected.",
      "",
      "Reconnect it in **Settings → Connectors → GitHub** (you may need to re-install the Zavi Engineer GitHub App on the account that owns the repo), then re-send your message.",
      "",
      ghAction,
    ].join("\n");
    return {
      markdown: ghMarkdown.length > BODY_CAP ? ghMarkdown.slice(0, BODY_CAP) : ghMarkdown,
      action_link: ghAction,
    };
  }

  if (WORKTREE_DISK_RE.test(rawError)) {
    const diskMarkdown =
      "My workspace ran out of room while setting up for your request — this is a " +
      "limit on my end, not a problem with what you asked for. It's being handled " +
      "on our side; no action is needed from you.";
    return {
      markdown:
        diskMarkdown.length > BODY_CAP ? diskMarkdown.slice(0, BODY_CAP) : diskMarkdown,
      action_link: null,
    };
  }

  if (WORKTREE_MISSING_BASE_RE.test(rawError)) {
    const missingBaseMarkdown = WORKTREE_EMPTY_REPO_RE.test(rawError)
      ? "Your site's code repository has no commits yet, so I couldn't find a " +
        "branch to work from. This usually means your site build didn't finish. " +
        "Open your site build and click Retry build, then ask me again. If this is " +
        "a GitHub repo you connected yourself, check your GitHub connection in " +
        "Integrations and tell me which repo and branch to use."
      : "I couldn't find the branch to work from in your repository. It may have " +
        "been renamed or deleted. Tell me which branch to use and I'll work from " +
        "that instead.";
    return {
      markdown:
        missingBaseMarkdown.length > BODY_CAP
          ? missingBaseMarkdown.slice(0, BODY_CAP)
          : missingBaseMarkdown,
      action_link: null,
    };
  }

  if (WORKTREE_SETUP_RE.test(rawError)) {
    const setupMarkdown =
      "I hit a problem setting up your repository on my end for this run — this " +
      "is an infrastructure issue, not a problem with your request. Please try " +
      "again in a few minutes.";
    return {
      markdown:
        setupMarkdown.length > BODY_CAP ? setupMarkdown.slice(0, BODY_CAP) : setupMarkdown,
      action_link: null,
    };
  }

  const rateLimitHit = RATE_LIMIT_RE.test(sanitized);
  const transientHit = TRANSIENT_RE.test(sanitized);

  if (!rateLimitHit && !transientHit) {
    const connectM = sanitized.match(CONNECT_RE);
    const reauthM = sanitized.match(AUTH_EXPIRED_RE);
    if (reauthM) {
      const slug = reauthM[1];
      const label = titleCaseSlug(slug);
      action_link = `[Reconnect ${label}](/__praxis_action__/reauth:${slug})`;
      trailer = `${action_link}`;
    } else if (connectM) {
      const slug = connectM[1];
      const label = titleCaseSlug(slug);
      action_link = `[Connect ${label}](/__praxis_action__/connect:${slug})`;
      trailer = `${action_link}`;
    } else {
      trailer = GENERIC_FAILURE_BODY;
      opener = null;
    }
  } else if (rateLimitHit) {
    trailer =
      "I'll try again in a few minutes — this is a transient rate-limit on the upstream service.";
  } else {
    trailer = "Transient network blip. Try the same question again.";
  }

  const markdown = [opener, opener ? "" : null, trailer]
    .filter((l): l is string => l !== null)
    .join("\n");

  return {
    markdown: markdown.length > BODY_CAP ? markdown.slice(0, BODY_CAP) : markdown,
    action_link,
  };
}

export const USAGE_LIMIT_FAILURE_BODY =
  "I couldn't finish this one — we briefly hit a usage limit on the AI service. " +
  "That's on our side and it clears on its own shortly. Please send your message " +
  "again in a little while and I'll pick it right back up.";

export function usageLimitFailureBody(rawError: string | null): string {
  const resetsAt = rawError ? parseUsageLimit(rawError).resetsAt : null;
  if (!resetsAt) return USAGE_LIMIT_FAILURE_BODY;
  return (
    "I couldn't finish this one — we briefly hit a usage limit on the AI service. " +
    `That's on our side; it resets around ${resetsAt}. Please resend your message ` +
    "after that and I'll pick it right back up."
  );
}

export function chatFailureBubbleBody(
  rawError: string | null,
  agent_slug: string,
): string {
  if (isUsageLimitError(rawError)) return usageLimitFailureBody(rawError);
  return synthesizeErrorBody(rawError ?? "unknown error", agent_slug).markdown;
}

export function providerOutageBody(rawError: string | null): string | null {
  if (!rawError) return null;
  if (isOurSeatAuthError(rawError)) return SEAT_FAILURE_BODY;
  if (isProviderUsageLimitError(rawError)) return usageLimitFailureBody(rawError);
  if (PROVIDER_OVERLOAD_RE.test(rawError)) return GENERIC_FAILURE_BODY;
  return null;
}

export function assistantVisibleRunError(rawError: string): string {
  const commerce = assistantSafeRunError(rawError);
  if (commerce !== rawError) return commerce;
  return providerOutageBody(rawError) ?? rawError;
}
