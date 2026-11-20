
import { serviceClient } from "@/services/supabase";
import { isCodeSymbolIndexEnabled } from "@/services/code-index/build";

const MAX_SYMBOLS_PROBED = 12;

export type WiringCheckOutcome = {
  status: "ok" | "unverified" | "skipped";
  unwired_symbols: string[];
  probed_count: number;
  reason?: string;
  exempt_by_framework_count?: number;
  exempt_by_escape_hatch_count?: number;
};

const APP_ROUTER_FILE_RE =
  /(?:^|\/)app\/(?:.*\/)?(?:page|layout|loading|error|not-found|route|template|default)\.[jt]sx?$/i;

const APP_ROUTER_FRAMEWORK_EXPORTS = new Set([
  "metadata",
  "generateMetadata",
  "generateStaticParams",
  "generateViewport",
  "viewport",
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "size",
  "alt",
  "default",
  "Page",
  "Layout",
  "Loading",
  "Error",
  "NotFound",
  "Route",
  "Template",
]);

export function isAppRouterFrameworkExempt(
  symbol: string,
  filePath: string,
  isDefault: boolean,
): boolean {
  if (!APP_ROUTER_FILE_RE.test(filePath)) return false;
  if (isDefault) return true;
  return APP_ROUTER_FRAMEWORK_EXPORTS.has(symbol);
}

export function diffCreatesRefInDefFile(
  symbol: string,
  defFilePath: string,
  files: DiffFile[],
): boolean {
  const defFile = files.find((f) => f.path === defFilePath);
  if (!defFile || defFile.action === "delete") return false;

  const wordRe = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const declRe = new RegExp(
    `^export\\s+(?:default\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function\\*?|class|const|let|var|interface|type|enum)\\s+${escapeRegExp(symbol)}\\b`,
  );

  const addedLines =
    typeof defFile.diff === "string" && defFile.diff.length > 0
      ? defFile.diff
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
      : defFile.action === "create" && typeof defFile.content === "string"
        ? defFile.content.split("\n")
        : [];

  const usageLines = addedLines.filter(
    (line) => wordRe.test(line) && !declRe.test(line.trimStart()),
  );
  return usageLines.length > 0;
}

export function parseDeclaredWiredSymbols(prBody: string): Set<string> {
  const wired = new Set<string>();
  if (!prBody || typeof prBody !== "string") return wired;

  const headingRe = /^#{1,6}\s+Wiring\b/im;
  const match = headingRe.exec(prBody);
  if (!match) return wired;

  const afterHeading = prBody.slice(match.index + match[0].length);
  const nextHeadingRe = /^#{1,6}\s+/m;
  const nextMatch = nextHeadingRe.exec(afterHeading);
  const section = nextMatch
    ? afterHeading.slice(0, nextMatch.index)
    : afterHeading;

  const identRe = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(section)) !== null) {
    const name = m[1];
    if (name && name.length > 1) wired.add(name);
  }
  return wired;
}

type DiffFile = {
  path: string;
  action: "create" | "modify" | "delete";
  diff?: string;
  content?: string;
};

function isIndexedSource(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx)$/i.test(filePath) && !filePath.endsWith(".d.ts");
}

const EXPORT_DECL_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

const EXPORT_DEFAULT_RE = /^export\s+default\s+/;

type ExportedSymbol = {
  name: string;
  isDefault: boolean;
};

export function extractNewExportedSymbols(file: DiffFile): ExportedSymbol[] {
  if (file.action === "delete") return [];
  if (!isIndexedSource(file.path)) return [];

  const seen = new Map<string, ExportedSymbol>();
  const recordSymbol = (line: string) => {
    const m = EXPORT_DECL_RE.exec(line);
    if (m && !seen.has(m[1])) {
      seen.set(m[1], { name: m[1], isDefault: EXPORT_DEFAULT_RE.test(line) });
    }
  };

  if (typeof file.diff === "string" && file.diff.length > 0) {
    for (const raw of file.diff.split("\n")) {
      if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
      recordSymbol(raw.slice(1).trimStart());
    }
  } else if (file.action === "create" && typeof file.content === "string") {
    for (const raw of file.content.split("\n")) {
      recordSymbol(raw.trimStart());
    }
  }
  return [...seen.values()];
}

function diffCreatesRefElsewhere(
  symbol: string,
  defFilePath: string,
  files: DiffFile[],
): boolean {
  const wordRe = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  for (const f of files) {
    if (f.path === defFilePath) continue;
    if (f.action === "delete") continue;
    const text =
      typeof f.diff === "string" && f.diff.length > 0
        ? f.diff
            .split("\n")
            .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
            .join("\n")
        : typeof f.content === "string"
          ? f.content
          : "";
    if (wordRe.test(text)) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function refsFilePaths(
  tenant_id: string,
  repo: string,
  symbol: string,
): Promise<string[] | null> {
  try {
    const { data, error } = await serviceClient().rpc("code_symbol_query", {
      p_tenant_id: tenant_id,
      p_repo: repo,
      p_symbol_name: symbol,
      p_query_embedding: null,
      p_mode: "refs",
    });
    if (error) {
      console.warn(
        `[engineer wiring-check] code_symbol_query(refs) failed for ${symbol}: ${error.message}`,
      );
      return null;
    }
    const rows = (data ?? []) as Array<{ file_path: string | null }>;
    return rows
      .map((r) => r.file_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch (e) {
    console.warn(
      `[engineer wiring-check] refs query threw for ${symbol}: ${(e as Error).message}`,
    );
    return null;
  }
}

async function hasCommittedIndex(tenant_id: string, repo: string): Promise<boolean | null> {
  try {
    const { data, error } = await serviceClient()
      .from("code_index_state")
      .select("current_build_id")
      .eq("tenant_id", tenant_id)
      .eq("repo_full_name", repo)
      .maybeSingle();
    if (error) return null;
    return (data as { current_build_id?: string | null } | null)?.current_build_id != null;
  } catch {
    return null;
  }
}

export async function checkDiffWiring(
  tenant_id: string,
  repo: string,
  files: DiffFile[],
  prBody?: string,
): Promise<WiringCheckOutcome> {
  if (!isCodeSymbolIndexEnabled()) {
    return { status: "skipped", unwired_symbols: [], probed_count: 0, reason: "index_disabled" };
  }

  const declaredWired = parseDeclaredWiredSymbols(prBody ?? "");

  const symbolDefs: Array<{ symbol: string; defFile: string; isDefault: boolean }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const { name, isDefault } of extractNewExportedSymbols(f)) {
      const key = `${f.path}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbolDefs.push({ symbol: name, defFile: f.path, isDefault });
    }
  }

  if (symbolDefs.length === 0) {
    return { status: "skipped", unwired_symbols: [], probed_count: 0, reason: "no_new_exports" };
  }

  let exemptByFrameworkCount = 0;
  let exemptByEscapeHatchCount = 0;

  const toProbe: Array<{ symbol: string; defFile: string }> = [];
  for (const { symbol, defFile, isDefault } of symbolDefs) {
    if (declaredWired.has(symbol)) {
      exemptByEscapeHatchCount++;
      continue;
    }
    if (isAppRouterFrameworkExempt(symbol, defFile, isDefault)) {
      exemptByFrameworkCount++;
      continue;
    }
    if (diffCreatesRefInDefFile(symbol, defFile, files)) {
      exemptByFrameworkCount++;
      continue;
    }
    toProbe.push({ symbol, defFile });
  }

  if (toProbe.length === 0) {
    return {
      status: "ok",
      unwired_symbols: [],
      probed_count: 0,
      exempt_by_framework_count: exemptByFrameworkCount,
      exempt_by_escape_hatch_count: exemptByEscapeHatchCount,
    };
  }

  if ((await hasCommittedIndex(tenant_id, repo)) === false) {
    return {
      status: "skipped",
      unwired_symbols: [],
      probed_count: 0,
      reason: "index_not_ready",
      exempt_by_framework_count: exemptByFrameworkCount,
      exempt_by_escape_hatch_count: exemptByEscapeHatchCount,
    };
  }

  const probed = toProbe.slice(0, MAX_SYMBOLS_PROBED);
  const unwired: string[] = [];
  let anyQueryRan = false;

  for (const { symbol, defFile } of probed) {
    if (diffCreatesRefElsewhere(symbol, defFile, files)) continue;

    const paths = await refsFilePaths(tenant_id, repo, symbol);
    if (paths === null) {
      continue;
    }
    anyQueryRan = true;
    const externalRef = paths.some((p) => normalize(p) !== normalize(defFile));
    if (!externalRef) {
      unwired.push(symbol);
    }
  }

  if (!anyQueryRan && unwired.length === 0) {
    return {
      status: "skipped",
      unwired_symbols: [],
      probed_count: probed.length,
      reason: "index_not_ready",
      exempt_by_framework_count: exemptByFrameworkCount,
      exempt_by_escape_hatch_count: exemptByEscapeHatchCount,
    };
  }

  return {
    status: unwired.length > 0 ? "unverified" : "ok",
    unwired_symbols: unwired,
    probed_count: probed.length,
    exempt_by_framework_count: exemptByFrameworkCount,
    exempt_by_escape_hatch_count: exemptByEscapeHatchCount,
  };
}

function normalize(p: string): string {
  return p.replace(/^\.?\//, "").trim();
}
