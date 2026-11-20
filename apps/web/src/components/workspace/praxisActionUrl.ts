
import { connectInfoFor } from "@zavi/shared";

const ACTION_PREFIX = "/__praxis_action__/";
const CONNECT_VERBS = new Set(["connect", "reauth"]);

const ADD_REPO_RE = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})?)\/([a-zA-Z0-9._-]+)/;

export type PraxisAction =
  | { verb: "connect" | "reauth"; slug: string }
  | { verb: "add-repo"; owner: string; repo: string };

export function isPraxisActionHref(href: string | undefined | null): boolean {
  return typeof href === "string" && href.startsWith(ACTION_PREFIX);
}

export function parsePraxisAction(
  href: string | undefined | null,
): PraxisAction | null {
  if (typeof href !== "string" || !href.startsWith(ACTION_PREFIX)) return null;
  const rest = href.slice(ACTION_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx <= 0) return null;
  const verb = rest.slice(0, colonIdx);
  const rawArg = rest.slice(colonIdx + 1);

  if (CONNECT_VERBS.has(verb)) {
    const slug = rawArg.match(/^[a-z0-9_.-]+/)?.[0] ?? "";
    if (connectInfoFor(slug) === null) return null;
    return { verb: verb as "connect" | "reauth", slug };
  }

  if (verb === "add-repo") {
    const m = rawArg.match(ADD_REPO_RE);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2];
    if (!owner || !repo) return null;
    return { verb: "add-repo", owner, repo };
  }

  return null;
}
