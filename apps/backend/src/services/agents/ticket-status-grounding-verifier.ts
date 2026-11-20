
import type { ShipEvidence } from "./repo-ship-probe";
export type { ShipEvidence };

export type StatusClaimDetection = {
  isPending: boolean;
  anchors: {
    ticketKeys: string[];
    symbols: string[];
    filePaths: string[];
  };
  pendingAnchors: {
    ticketKeys: string[];
    symbols: string[];
    filePaths: string[];
  };
};

const PENDING_BIND_WINDOW = 240;

export type StatusGroundingTier = "CORRECT" | "HEDGE" | "NOOP";

export type StatusGroundingResult = {
  tier: StatusGroundingTier;
  banner: string | null;
};

const TICKET_KEY_RE = /\b[A-Z]{2,}-\d+\b/g;

const PENDING_RE =
  /\b(pending|still open|in dev|in-dev|not (yet )?(done|shipped|implemented|merged)|work(-| )left|to ?do|still needs|not started|awaiting|outstanding|remaining work)\b/i;

const BACKTICK_SPAN_RE = /`([^`]+)`/g;
const SYMBOL_SHAPE_RE = /^[A-Za-z_$][\w$]*(?:[./][\w$]+)*$/;
const LOOKS_LIKE_SYMBOL_RE =
  /[a-z][A-Z]|[A-Za-z_$][\w$]*\.[A-Za-z_$]|^\/[\w./-]+/;

const FILE_PATH_RE = /[\w./-]+\.(?:ts|tsx|swift|kt|js)\b/g;

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

type PositionedAnchor = { value: string; index: number };

function positionedAnchors(src: string): {
  ticketKeys: PositionedAnchor[];
  symbols: PositionedAnchor[];
  filePaths: PositionedAnchor[];
} {
  const ticketKeys: PositionedAnchor[] = [];
  for (const m of src.matchAll(TICKET_KEY_RE)) {
    ticketKeys.push({ value: m[0], index: m.index ?? 0 });
  }

  const symbols: PositionedAnchor[] = [];
  for (const m of src.matchAll(BACKTICK_SPAN_RE)) {
    const span = m[1].trim();
    if (
      span.length > 0 &&
      span.length <= 80 &&
      !span.includes(" ") &&
      SYMBOL_SHAPE_RE.test(span) &&
      LOOKS_LIKE_SYMBOL_RE.test(span)
    ) {
      symbols.push({ value: span, index: m.index ?? 0 });
    }
  }

  const filePaths: PositionedAnchor[] = [];
  for (const m of src.matchAll(FILE_PATH_RE)) {
    filePaths.push({ value: m[0], index: m.index ?? 0 });
    symbols.push({ value: m[0], index: m.index ?? 0 });
  }

  return { ticketKeys, symbols, filePaths };
}

const PENDING_RE_GLOBAL = new RegExp(
  PENDING_RE.source,
  PENDING_RE.flags.includes("g") ? PENDING_RE.flags : PENDING_RE.flags + "g",
);

function pendingOffsets(src: string): number[] {
  const out: number[] = [];
  for (const m of src.matchAll(PENDING_RE_GLOBAL)) {
    out.push(m.index ?? 0);
  }
  return out;
}

function bindToPending(
  anchors: PositionedAnchor[],
  pendingIdx: number[],
): string[] {
  if (pendingIdx.length === 0) return [];
  const scored: { value: string; dist: number }[] = [];
  for (const a of anchors) {
    let best = Infinity;
    for (const p of pendingIdx) best = Math.min(best, Math.abs(p - a.index));
    if (best <= PENDING_BIND_WINDOW) scored.push({ value: a.value, dist: best });
  }
  scored.sort((x, y) => x.dist - y.dist);
  return uniq(scored.map((s) => s.value));
}

export function detectStatusClaim(text: string): StatusClaimDetection {
  const src = typeof text === "string" ? text : "";

  const pos = positionedAnchors(src);
  const anchors = {
    ticketKeys: uniq(pos.ticketKeys.map((a) => a.value)),
    symbols: uniq(pos.symbols.map((a) => a.value)),
    filePaths: uniq(pos.filePaths.map((a) => a.value)),
  };

  const pendingIdx = pendingOffsets(src);
  const pendingAnchors = {
    ticketKeys: bindToPending(pos.ticketKeys, pendingIdx),
    symbols: bindToPending(pos.symbols, pendingIdx),
    filePaths: bindToPending(pos.filePaths, pendingIdx),
  };

  const hasBoundAnchor =
    pendingAnchors.ticketKeys.length > 0 ||
    pendingAnchors.symbols.length > 0 ||
    pendingAnchors.filePaths.length > 0;

  const isPending = pendingIdx.length > 0 && hasBoundAnchor;
  return { isPending, anchors, pendingAnchors };
}

export type StatusProbeInputs = {
  ticketKey?: string;
  symbols: string[];
  filePath?: string;
};

function unitAround(text: string, needle: string): string {
  const i = text.indexOf(needle);
  if (i < 0) return "";
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(/[.!?](?=\s|$)|\n/g)) {
    const pos = m.index ?? 0;
    if (pos < i) start = pos + m[0].length;
    else {
      end = pos;
      break;
    }
  }
  return text.slice(start, end);
}

export function selectProbeInputs(
  det: StatusClaimDetection,
  text: string,
): StatusProbeInputs {
  const src = typeof text === "string" ? text : "";
  const singleSubject = det.anchors.ticketKeys.length <= 1;
  const ticketKey = det.pendingAnchors.ticketKeys[0];

  const symbols = det.pendingAnchors.symbols.length
    ? det.pendingAnchors.symbols
    : singleSubject
      ? det.anchors.symbols
      : [];

  let filePath: string | undefined;
  if (singleSubject || !ticketKey) {
    filePath = det.pendingAnchors.filePaths[0] ?? det.anchors.filePaths[0];
  } else {
    const unit = unitAround(src, ticketKey);
    filePath =
      det.pendingAnchors.filePaths.find((fp) => unit.includes(fp)) ?? undefined;
  }

  return { ticketKey, symbols, filePath };
}

function sha7(sha: string): string {
  return (sha ?? "").slice(0, 7);
}

function pathAnchorMatches(anchor: string, contractPath: string): boolean {
  const a = anchor.replace(/^\.?\//, "");
  const c = contractPath.replace(/^\.?\//, "");
  if (a === c) return true;
  return c.endsWith(`/${a}`) || a.endsWith(`/${c}`);
}

export function verifyStatusRealityGrounding(
  text: string,
  evidence: ShipEvidence | null,
): StatusGroundingResult {
  const noop: StatusGroundingResult = { tier: "NOOP", banner: null };
  if (!evidence) return noop;

  const src = typeof text === "string" ? text : "";
  const det = detectStatusClaim(src);
  if (!det.isPending) return noop;

  const hasCommit = evidence.shipping_commits.length > 0;
  const contractPath = evidence.contract_path;
  const hasSnippet =
    typeof evidence.contract_snippet === "string" &&
    evidence.contract_snippet.trim().length > 0;
  const hasContract =
    hasSnippet &&
    typeof contractPath === "string" &&
    det.anchors.filePaths.some((fp) => pathAnchorMatches(fp, contractPath));
  const hasAnchor =
    det.anchors.ticketKeys.length > 0 ||
    det.anchors.symbols.length > 0 ||
    det.anchors.filePaths.length > 0;

  if (!hasCommit && !evidence.incomplete) return noop;

  if (hasCommit && hasContract && hasAnchor) {
    const c = evidence.shipping_commits[0];
    const keyPart = c.key ? ` (\`${c.key}\`)` : "";
    const banner =
      `This looks already shipped. Commit \`${sha7(c.sha)}\`${keyPart} in ` +
      `${c.repo} matches the code, and the live file confirms it is in place. ` +
      `The status below may be stale, so verify before treating it as open.`;
    return { tier: "CORRECT", banner };
  }

  if (hasCommit || evidence.incomplete || evidence.repo_scope_ok === false) {
    const lead = hasCommit
      ? `This may already be shipped. Commit \`${sha7(
          evidence.shipping_commits[0].sha,
        )}\` looks related`
      : `This may already be shipped, but the check could not be completed`;
    const banner =
      `${lead}, so verify against the repo before treating the status below ` +
      `as current.`;
    return { tier: "HEDGE", banner };
  }

  return noop;
}
