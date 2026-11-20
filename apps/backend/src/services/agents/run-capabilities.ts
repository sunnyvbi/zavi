
export type ResolvedToolLike = { name: string };

export function connectorsFromResolvedTools(tools: readonly ResolvedToolLike[]): string[] {
  const fams = new Set<string>();
  for (const t of tools) {
    const parts = (t?.name ?? "").split("__").filter(Boolean);
    if (parts.length < 2) continue;
    const family = parts[parts.length - 2];
    if (family === "mcp" || family === "server") continue;
    fams.add(family);
  }
  return Array.from(fams).sort();
}

const TENANT_SCOPE_LINES: readonly string[] = [
  "TENANT SCOPE — this run can see exactly ONE workspace: the tenant it is running for.",
  "You have NO cross-tenant visibility. Other customers, other companies, and other",
  "workspaces are invisible to you and to EVERY tool listed below, including memory.",
  "So when you cannot find something, say it is not in THIS workspace. NEVER say that it",
  "does not exist, that a named person or company 'is not a client', or that you checked",
  "'any connected system', 'anywhere', or 'all systems'. Those claims are false by",
  "construction here: the only thing you searched was this one workspace. Report the",
  "bound you actually searched — never a conclusion about the world beyond it.",
];

export function buildRunCapabilitiesBlock(
  connected: readonly string[],
  disconnected: readonly string[],
  canRequestConnector = false,
): string {
  const lines: string[] = [
    "RUN CAPABILITIES (system-derived — outranks memory)",
    ...TENANT_SCOPE_LINES,
  ];

  if (connected.length > 0) {
    lines.push(
      `CONNECTED — these tool families are resolved and callable by you THIS RUN: ${connected.join(", ")}.`,
      "You DO have them. Never tell the operator one of these is 'not connected', 'not wired', or",
      "unavailable — that claim is false and this line is the live system state, not a recollection.",
      "If a memory note says otherwise, the NOTE is stale: trust this list and call the tool.",
      "If a call then fails, report the ACTUAL error — never a guess about connection state.",
    );
  }
  if (disconnected.length > 0) {
    lines.push(`NOT CONNECTED — no tools resolved for: ${disconnected.join(", ")}.`);
  }
  if (canRequestConnector) {
    lines.push(
      "If the ask needs live data or an action from a service that isn't connected, call connectors__request (use connectors__search to find the slug). Answer plain questions normally.",
    );
  }
  return lines.join("\n");
}

const DOWN_PHRASE =
  /\b(?:not|isn['’]t|aren['’]t|never|no)\s+(?:yet\s+)?(?:been\s+)?(?:connected|wired|set\s?up|integrated|configured|available|enabled)\b|\b(?:dis?connected|unwired|offline|missing|unavailable|pending)\b/i;

const SETUP_HISTORY_DOWN_PHRASE =
  /\b(?:not|isn['’]t|aren['’]t|never|no)\s+(?:yet\s+)?(?:been\s+)?(?:connected|wired|set\s?up|integrated|configured|enabled)\b|\bunwired\b/i;

const TENANT_PRODUCT_CONTEXT =
  /\b(?:host|hosts|payout|payouts|paid|payment[s]?\s+to|funds|earning[s]?|flywheel|guest|guests|driver[s]?|seller[s]?|merchant[s]?)\b/i;

export function contradictedConnector(
  text: string,
  connected: readonly string[],
): string | null {
  return contradictedBy(text, connected, DOWN_PHRASE);
}

export function contradictedSetupHistoryConnector(
  text: string,
  connected: readonly string[],
): string | null {
  return contradictedBy(text, connected, SETUP_HISTORY_DOWN_PHRASE);
}

function contradictedBy(
  text: string,
  connected: readonly string[],
  phrase: RegExp,
): string | null {
  if (!text || connected.length === 0) return null;
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (!phrase.test(sentence)) continue;
    if (TENANT_PRODUCT_CONTEXT.test(sentence)) continue;
    for (const slug of connected) {
      const token = new RegExp(`\\b${slug.replace(/[^a-z0-9_]/gi, "")}\\b`, "i");
      if (token.test(sentence)) return slug;
    }
  }
  return null;
}

export function withheldNoteStub(slug: string): string {
  return (
    `[stale claim withheld: this note said "${slug}" is not connected. The operator HAS set up ` +
    `"${slug}" (it is in this tenant's connector roster), so a blanket "not connected" is stale and ` +
    `was removed so it cannot be repeated as fact. See RUN CAPABILITIES for whether "${slug}" is ` +
    `callable THIS run; if a call fails, report the actual error. The rest of the note is unchanged.]`
  );
}

export function stripContradictedSetupClaims(
  body: string,
  connected: readonly string[],
): { text: string; withheld: string[] } {
  if (!body || connected.length === 0) return { text: body, withheld: [] };
  const withheld: string[] = [];
  const parts = body.split(/(?<=[.!?\n])/);
  const out = parts.map((sentence) => {
    const bad = contradictedSetupHistoryConnector(sentence, connected);
    if (!bad) return sentence;
    withheld.push(bad);
    return sentence.match(/\n\s*$/)?.[0] ?? "";
  });
  return { text: out.join(""), withheld: Array.from(new Set(withheld)) };
}

export function redactContradictedClaims(
  body: string,
  connected: readonly string[],
): { text: string; withheld: string[] } {
  if (!body || connected.length === 0) return { text: body, withheld: [] };
  const withheld: string[] = [];
  const parts = body.split(/(?<=[.!?\n])/);
  const out = parts.map((sentence) => {
    const bad = contradictedConnector(sentence, connected);
    if (!bad) return sentence;
    withheld.push(bad);
    const tail = sentence.match(/\s*$/)?.[0] ?? "";
    return withheldNoteStub(bad) + tail;
  });
  return { text: out.join(""), withheld: Array.from(new Set(withheld)) };
}
