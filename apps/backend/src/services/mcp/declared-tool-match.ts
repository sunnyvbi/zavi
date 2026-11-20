
import { fromAnthropicName, MCP_NAME_SEPARATOR } from "./types";

const WILDCARD_SUFFIX = `${MCP_NAME_SEPARATOR}*`;
const PREFIX_WILDCARD_RE = /^(.+?)\*__\*$/;

export interface DeclaredToolMatchers {
  exact: ReadonlySet<string>;
  wildcardServers: ReadonlySet<string>;
  prefixWildcards: readonly string[];
}

export function parseDeclaredToolMatchers(
  declared: readonly string[],
): DeclaredToolMatchers {
  const exact = new Set<string>();
  const wildcardServers = new Set<string>();
  const prefixWildcards: string[] = [];
  for (const d of declared) {
    const pfx = d.match(PREFIX_WILDCARD_RE);
    if (pfx) {
      prefixWildcards.push(pfx[1]);
      continue;
    }
    if (d.endsWith(WILDCARD_SUFFIX)) {
      wildcardServers.add(d.slice(0, -WILDCARD_SUFFIX.length));
      continue;
    }
    exact.add(d);
  }
  return { exact, wildcardServers, prefixWildcards };
}

function matchesPrefix(
  server_id: string,
  prefixWildcards: readonly string[],
): boolean {
  for (const p of prefixWildcards) if (server_id.startsWith(p)) return true;
  return false;
}

export function toolMatchesDeclared(
  anthropic_name: string,
  matchers: DeclaredToolMatchers,
): boolean {
  if (matchers.exact.has(anthropic_name)) return true;
  const parts = fromAnthropicName(anthropic_name);
  if (!parts) return false;
  if (matchers.wildcardServers.has(parts.server_id)) return true;
  if (matchesPrefix(parts.server_id, matchers.prefixWildcards)) return true;
  return false;
}

export function makeLiveToolMatcher(
  liveTools: readonly string[],
): (anthropic_name: string) => boolean {
  const matchers = parseDeclaredToolMatchers(liveTools);
  return (name: string) => toolMatchesDeclared(name, matchers);
}
