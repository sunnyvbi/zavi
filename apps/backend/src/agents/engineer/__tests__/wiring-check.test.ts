
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/code-index/build", () => ({
  isCodeSymbolIndexEnabled: vi.fn(() => true),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    rpc: vi.fn((_name: string, _params: unknown) =>
      Promise.resolve({ data: [], error: null }),
    ),
  })),
}));

import {
  checkDiffWiring,
  extractNewExportedSymbols,
  isAppRouterFrameworkExempt,
  diffCreatesRefInDefFile,
  parseDeclaredWiredSymbols,
} from "@/agents/engineer/wiring-check";
import { isCodeSymbolIndexEnabled } from "@/services/code-index/build";
import { serviceClient } from "@/services/supabase";

function makeFile(
  path: string,
  action: "create" | "modify" | "delete",
  diff?: string,
  content?: string,
) {
  return { path, action, diff, content };
}

function addedExportDiff(declaration: string): string {
  return `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -0,0 +1,1 @@\n+${declaration}\n`;
}

describe("isAppRouterFrameworkExempt (B1.1a)", () => {
  it("default export from app/**/page.tsx → exempt", () => {
    expect(isAppRouterFrameworkExempt("LoginPage", "app/login/page.tsx", true)).toBe(true);
  });

  it("named 'metadata' from app/**/page.tsx → exempt", () => {
    expect(isAppRouterFrameworkExempt("metadata", "app/login/page.tsx", false)).toBe(true);
  });

  it("named 'generateMetadata' from app/**/layout.tsx → exempt", () => {
    expect(isAppRouterFrameworkExempt("generateMetadata", "src/app/dashboard/layout.tsx", false)).toBe(true);
  });

  it("named 'generateStaticParams' from app/**/page.tsx → exempt", () => {
    expect(isAppRouterFrameworkExempt("generateStaticParams", "app/blog/[slug]/page.tsx", false)).toBe(true);
  });

  it("non-framework named export from app/**/page.tsx → NOT exempt", () => {
    expect(isAppRouterFrameworkExempt("MyHelper", "app/login/page.tsx", false)).toBe(false);
  });

  it("default export from a regular (non-route) file → NOT exempt", () => {
    expect(isAppRouterFrameworkExempt("MyComponent", "src/components/Button.tsx", true)).toBe(false);
  });

  it("app/**/loading.tsx default export → exempt", () => {
    expect(isAppRouterFrameworkExempt("Loading", "app/dashboard/loading.tsx", true)).toBe(true);
  });

  it("app/**/error.tsx default export → exempt", () => {
    expect(isAppRouterFrameworkExempt("ErrorPage", "app/error.tsx", true)).toBe(true);
  });

  it("app/**/not-found.tsx default export → exempt", () => {
    expect(isAppRouterFrameworkExempt("NotFound", "app/not-found.tsx", true)).toBe(true);
  });

  it("app/**/route.ts default export → exempt", () => {
    expect(isAppRouterFrameworkExempt("GET", "app/api/health/route.ts", true)).toBe(true);
  });
});

describe("diffCreatesRefInDefFile (B1.1b)", () => {
  it("symbol used on a non-declaration line in the same file → true", () => {
    const diff = [
      "--- a/src/utils.ts",
      "+++ b/src/utils.ts",
      "@@ -0,0 +1,5 @@",
      "+export function toDayKey(date: Date): string {",
      "+  return date.toISOString().slice(0, 10);",
      "+}",
      "+export function addDays(d: Date, n: number): Date {",
      "+  const copy = new Date(d); copy.setDate(d.getDate() + n); return copy;",
      "+}",
      "+export const WEEK_START = toDayKey(new Date());",
    ].join("\n");

    const files = [makeFile("src/utils.ts", "modify", diff)];
    expect(diffCreatesRefInDefFile("toDayKey", "src/utils.ts", files)).toBe(true);
  });

  it("symbol defined but NOT used in the same file → false", () => {
    const diff = [
      "--- a/src/utils.ts",
      "+++ b/src/utils.ts",
      "@@ -0,0 +1,3 @@",
      "+export function addDays(d: Date, n: number): Date {",
      "+  const copy = new Date(d); copy.setDate(d.getDate() + n); return copy;",
      "+}",
    ].join("\n");
    const files = [makeFile("src/utils.ts", "modify", diff)];
    expect(diffCreatesRefInDefFile("addDays", "src/utils.ts", files)).toBe(false);
  });

  it("created file (content) with in-file usage → true", () => {
    const content = [
      "export function toDayKey(date: Date): string {",
      "  return date.toISOString().slice(0, 10);",
      "}",
      "export const TODAY = toDayKey(new Date()); // uses toDayKey",
    ].join("\n");
    const files = [makeFile("src/utils.ts", "create", undefined, content)];
    expect(diffCreatesRefInDefFile("toDayKey", "src/utils.ts", files)).toBe(true);
  });

  it("file not in the diff → false (no false-positive)", () => {
    const files = [makeFile("src/other.ts", "create", undefined, "export const x = 1;")];
    expect(diffCreatesRefInDefFile("toDayKey", "src/utils.ts", files)).toBe(false);
  });
});

describe("parseDeclaredWiredSymbols (B1.2)", () => {
  it("extracts backtick-wrapped symbol from ### Wiring section", () => {
    const body = "## Summary\nDid a thing.\n### Wiring\n`MyHandler` is registered via DB dispatch map.\n## Tests\nAll pass.";
    const set = parseDeclaredWiredSymbols(body);
    expect(set.has("MyHandler")).toBe(true);
  });

  it("extracts multiple symbols", () => {
    const body = "### Wiring\n`addDays` and `toDayKey` are used only within the same module.";
    const set = parseDeclaredWiredSymbols(body);
    expect(set.has("addDays")).toBe(true);
    expect(set.has("toDayKey")).toBe(true);
  });

  it("F7 — does NOT capture bare prose words (backtick-only)", () => {
    const body = "### Wiring\nThis handler registers dynamically via the dispatch map.";
    const set = parseDeclaredWiredSymbols(body);
    for (const w of ["handler", "registers", "dynamically", "dispatch", "map", "via"]) {
      expect(set.has(w)).toBe(false);
    }
    expect(set.size).toBe(0);
  });

  it("F7 — captures backticked identifiers but NOT the surrounding prose", () => {
    const body = "### Wiring\n`fooHandler` is registered via the dispatch map.";
    const set = parseDeclaredWiredSymbols(body);
    expect(set.has("fooHandler")).toBe(true);
    expect(set.has("registered")).toBe(false);
    expect(set.has("dispatch")).toBe(false);
  });

  it("returns empty set when no ### Wiring heading", () => {
    const body = "## Summary\nNo wiring section here.";
    const set = parseDeclaredWiredSymbols(body);
    expect(set.size).toBe(0);
  });

  it("stops at the next heading", () => {
    const body = "### Wiring\n`GoodSymbol` registered.\n## NextSection\n`ShouldNotBeParsed` should be ignored.";
    const set = parseDeclaredWiredSymbols(body);
    expect(set.has("GoodSymbol")).toBe(true);
  });

  it("is defensive: empty string returns empty set", () => {
    expect(parseDeclaredWiredSymbols("").size).toBe(0);
  });

  it("case-insensitive heading match", () => {
    const body = "### wiring\n`MyFn` is dynamic.";
    const set = parseDeclaredWiredSymbols(body);
    expect(set.has("MyFn")).toBe(true);
  });
});

describe("extractNewExportedSymbols", () => {
  it("marks default export as isDefault=true", () => {
    const diff = addedExportDiff("export default function LoginPage() {}");
    const file = makeFile("app/login/page.tsx", "modify", diff);
    const syms = extractNewExportedSymbols(file);
    const sym = syms.find((s) => s.name === "LoginPage");
    expect(sym).toBeDefined();
    expect(sym!.isDefault).toBe(true);
  });

  it("marks named export as isDefault=false", () => {
    const diff = addedExportDiff("export const metadata = { title: 'Login' };");
    const file = makeFile("app/login/page.tsx", "modify", diff);
    const syms = extractNewExportedSymbols(file);
    const sym = syms.find((s) => s.name === "metadata");
    expect(sym).toBeDefined();
    expect(sym!.isDefault).toBe(false);
  });

  it("returns empty array for delete action", () => {
    const file = makeFile("app/login/page.tsx", "delete");
    expect(extractNewExportedSymbols(file)).toHaveLength(0);
  });

  it("returns empty array for non-indexed file (.css)", () => {
    const file = makeFile("app/login/page.css", "create", undefined, ".login { color: red; }");
    expect(extractNewExportedSymbols(file)).toHaveLength(0);
  });
});

describe("checkDiffWiring — fixture 1: App Router page diff", () => {
  beforeEach(() => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
    vi.mocked(serviceClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    } as unknown as ReturnType<typeof serviceClient>);
  });

  it("app-router page with default + metadata exports → ok/skipped (NOT blocked)", async () => {
    const diff = [
      "--- a/app/login/page.tsx",
      "+++ b/app/login/page.tsx",
      "@@ -0,0 +1,6 @@",
      "+import type { Metadata } from 'next';",
      "+export const metadata: Metadata = { title: 'Login' };",
      "+export default function LoginPage() {",
      "+  return <div>Login</div>;",
      "+}",
    ].join("\n");

    const files = [makeFile("app/login/page.tsx", "modify", diff)];
    const result = await checkDiffWiring("tenant-1", "owner/repo", files);

    expect(["ok", "skipped"]).toContain(result.status);
    expect(result.unwired_symbols).toHaveLength(0);
  });

  it("Home component as default export in app/page.tsx → ok/skipped", async () => {
    const diff = [
      "--- a/app/page.tsx",
      "+++ b/app/page.tsx",
      "@@ -0,0 +1,3 @@",
      "+export default function Home() {",
      "+  return <main>Hello</main>;",
      "+}",
    ].join("\n");

    const files = [makeFile("app/page.tsx", "modify", diff)];
    const result = await checkDiffWiring("tenant-1", "owner/repo", files);

    expect(["ok", "skipped"]).toContain(result.status);
    expect(result.unwired_symbols).toHaveLength(0);
  });
});

describe("checkDiffWiring — fixture 2: in-file helper diff", () => {
  beforeEach(() => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
    vi.mocked(serviceClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    } as unknown as ReturnType<typeof serviceClient>);
  });

  it("toDayKey exported + used on another line in the same file → ok/skipped (NOT blocked)", async () => {
    const diff = [
      "--- a/src/date-utils.ts",
      "+++ b/src/date-utils.ts",
      "@@ -0,0 +1,5 @@",
      "+export function toDayKey(date: Date): string {",
      "+  return date.toISOString().slice(0, 10);",
      "+}",
      "+function formatRange(start: Date, end: Date) {",
      "+  return `${toDayKey(start)} to ${toDayKey(end)}`;",
      "+}",
    ].join("\n");

    const files = [makeFile("src/date-utils.ts", "modify", diff)];
    const result = await checkDiffWiring("tenant-1", "owner/repo", files);

    expect(["ok", "skipped"]).toContain(result.status);
    expect(result.unwired_symbols).not.toContain("toDayKey");
  });

  it("addDays exported + used in same file via another function → ok/skipped", async () => {
    const diff = [
      "--- a/src/date-utils.ts",
      "+++ b/src/date-utils.ts",
      "@@ -0,0 +1,7 @@",
      "+export function addDays(d: Date, n: number): Date {",
      "+  const copy = new Date(d);",
      "+  copy.setDate(d.getDate() + n);",
      "+  return copy;",
      "+}",
      "+function nextWeek(d: Date) {",
      "+  return addDays(d, 7);",
      "+}",
    ].join("\n");

    const files = [makeFile("src/date-utils.ts", "modify", diff)];
    const result = await checkDiffWiring("tenant-1", "owner/repo", files);

    expect(["ok", "skipped"]).toContain(result.status);
    expect(result.unwired_symbols).not.toContain("addDays");
  });
});

describe("checkDiffWiring — fixture 3: genuinely unwired symbol still flagged", () => {
  beforeEach(() => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
    vi.mocked(serviceClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    } as unknown as ReturnType<typeof serviceClient>);
  });

  it("exported handler with NO in-file usage + NO external refs → still flagged unverified", async () => {
    const diff = [
      "--- a/src/handlers/my-handler.ts",
      "+++ b/src/handlers/my-handler.ts",
      "@@ -0,0 +1,3 @@",
      "+export function deepHealthHandler(req: Request, res: Response) {",
      "+  res.json({ ok: true });",
      "+}",
    ].join("\n");

    const files = [makeFile("src/handlers/my-handler.ts", "modify", diff)];
    const result = await checkDiffWiring("tenant-1", "owner/repo", files);

    expect(result.status).toBe("unverified");
    expect(result.unwired_symbols).toContain("deepHealthHandler");
  });
});

describe("checkDiffWiring — fixture 4: ### Wiring escape hatch", () => {
  beforeEach(() => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
    vi.mocked(serviceClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    } as unknown as ReturnType<typeof serviceClient>);
  });

  it("flagged symbol declared under ### Wiring in PR body → ok (not blocked)", async () => {
    const diff = [
      "--- a/src/dispatch/my-dispatch.ts",
      "+++ b/src/dispatch/my-dispatch.ts",
      "@@ -0,0 +1,3 @@",
      "+export function MyDispatchHandler(ctx: Context) {",
      "+  // registered via DB dispatch map",
      "+}",
    ].join("\n");
    const files = [makeFile("src/dispatch/my-dispatch.ts", "modify", diff)];

    const prBody = [
      "## Summary",
      "Added a new dispatch handler.",
      "### Wiring",
      "`MyDispatchHandler` registered via DB dispatch map — see dispatch_handlers table.",
      "## Tests",
      "Unit tests added.",
    ].join("\n");

    const result = await checkDiffWiring("tenant-1", "owner/repo", files, prBody);

    expect(result.status).toBe("ok");
    expect(result.unwired_symbols).toHaveLength(0);
    expect(result.exempt_by_escape_hatch_count).toBeGreaterThan(0);
  });

  it("### Wiring declares one symbol but another remains unwired → partial ok", async () => {
    const diff = [
      "--- a/src/dispatch/stuff.ts",
      "+++ b/src/dispatch/stuff.ts",
      "@@ -0,0 +1,6 @@",
      "+export function Foo(ctx: unknown) {}",
      "+export function Bar(ctx: unknown) {}",
    ].join("\n");
    const files = [makeFile("src/dispatch/stuff.ts", "modify", diff)];

    const prBody = "### Wiring\n`Foo` is registered via DB dispatch map.";

    const result = await checkDiffWiring("tenant-1", "owner/repo", files, prBody);

    expect(result.unwired_symbols).toContain("Bar");
    expect(result.unwired_symbols).not.toContain("Foo");
    expect(result.status).toBe("unverified");
  });

  it("no ### Wiring section → same as without prBody (no spurious exemptions)", async () => {
    const diff = [
      "--- a/src/handlers/foo.ts",
      "+++ b/src/handlers/foo.ts",
      "@@ -0,0 +1,3 @@",
      "+export function FooHandler(req: Request) {}",
    ].join("\n");
    const files = [makeFile("src/handlers/foo.ts", "modify", diff)];
    const prBodyNoWiring = "## Summary\nDid a thing.\n## Tests\nNone.";

    const result = await checkDiffWiring("tenant-1", "owner/repo", files, prBodyNoWiring);

    expect(result.unwired_symbols).toContain("FooHandler");
  });
});

describe("checkDiffWiring — B1.4 telemetry counts", () => {
  beforeEach(() => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
    vi.mocked(serviceClient).mockReturnValue({
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    } as unknown as ReturnType<typeof serviceClient>);
  });

  it("framework-exempted symbols increment exempt_by_framework_count", async () => {
    const diff = [
      "--- a/app/login/page.tsx",
      "+++ b/app/login/page.tsx",
      "@@ -0,0 +1,2 @@",
      "+export const metadata = { title: 'Login' };",
      "+export default function LoginPage() {}",
    ].join("\n");
    const files = [makeFile("app/login/page.tsx", "modify", diff)];

    const result = await checkDiffWiring("t1", "owner/repo", files);

    expect((result.exempt_by_framework_count ?? 0)).toBeGreaterThan(0);
    expect(result.unwired_symbols).toHaveLength(0);
  });

  it("escape-hatch-exempted symbols increment exempt_by_escape_hatch_count", async () => {
    const diff = [
      "+export function DynHandler() {}",
    ].join("\n");
    const files = [makeFile("src/handlers/dyn.ts", "modify", `--- a\n+++ b\n@@ -0,0 +1 @@\n${diff}`)];
    const prBody = "### Wiring\n`DynHandler` registered dynamically.";

    const result = await checkDiffWiring("t1", "owner/repo", files, prBody);

    expect((result.exempt_by_escape_hatch_count ?? 0)).toBeGreaterThan(0);
  });

  it("no exemptions → both counts are 0 or undefined", async () => {
    const diff = [
      "--- a/src/handlers/bare.ts",
      "+++ b/src/handlers/bare.ts",
      "@@ -0,0 +1,1 @@",
      "+export function BareHandler() {}",
    ].join("\n");
    const files = [makeFile("src/handlers/bare.ts", "modify", diff)];

    const result = await checkDiffWiring("t1", "owner/repo", files);

    expect(result.exempt_by_framework_count ?? 0).toBe(0);
    expect(result.exempt_by_escape_hatch_count ?? 0).toBe(0);
  });
});

describe("checkDiffWiring — skip paths", () => {
  it("index_disabled → status skipped (no false UNWIRED)", async () => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(false);
    const diff = [
      "--- a/src/handlers/bare.ts",
      "+++ b/src/handlers/bare.ts",
      "@@ -0,0 +1,1 @@",
      "+export function BareHandler() {}",
    ].join("\n");
    const files = [makeFile("src/handlers/bare.ts", "modify", diff)];

    const result = await checkDiffWiring("t1", "owner/repo", files);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("index_disabled");
    expect(result.unwired_symbols).toHaveLength(0);
  });

  it("no new exports → status skipped no_new_exports", async () => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
    const diff = [
      "--- a/src/utils.ts",
      "+++ b/src/utils.ts",
      "@@ -1,1 +1,1 @@",
      "-const x = 1;",
      "+const x = 2; // no export",
    ].join("\n");
    const files = [makeFile("src/utils.ts", "modify", diff)];

    const result = await checkDiffWiring("t1", "owner/repo", files);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_new_exports");
  });
});

describe("checkDiffWiring — repo with no committed index", () => {
  const diff = [
    "--- a/src/handlers/my-handler.ts",
    "+++ b/src/handlers/my-handler.ts",
    "@@ -0,0 +1,3 @@",
    "+export function deepHealthHandler(req: Request, res: Response) {",
    "+  res.json({ ok: true });",
    "+}",
  ].join("\n");
  const files = [makeFile("src/handlers/my-handler.ts", "modify", diff)];

  function mockIndexState(state: { data: unknown; error: unknown } | "throws") {
    const rpc = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const maybeSingle = vi.fn(() => (state === "throws" ? Promise.reject(new Error("down")) : Promise.resolve(state)));
    const q = { select: () => q, eq: () => q, maybeSingle };
    vi.mocked(serviceClient).mockReturnValue({ rpc, from: vi.fn(() => q) } as unknown as ReturnType<typeof serviceClient>);
    return rpc;
  }

  beforeEach(() => {
    vi.mocked(isCodeSymbolIndexEnabled).mockReturnValue(true);
  });

  it("pointer cleared → skipped index_not_ready, nothing flagged, no refs queried", async () => {
    const rpc = mockIndexState({ data: { current_build_id: null }, error: null });
    const result = await checkDiffWiring("t1", "owner/repo", files);
    expect(result).toMatchObject({ status: "skipped", reason: "index_not_ready", unwired_symbols: [] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("no state row at all → skipped index_not_ready", async () => {
    mockIndexState({ data: null, error: null });
    expect((await checkDiffWiring("t1", "owner/repo", files)).reason).toBe("index_not_ready");
  });

  it("committed index → probes as before and still flags a genuinely unwired export", async () => {
    const rpc = mockIndexState({ data: { current_build_id: "b1" }, error: null });
    const result = await checkDiffWiring("t1", "owner/repo", files);
    expect(result.status).toBe("unverified");
    expect(result.unwired_symbols).toContain("deepHealthHandler");
    expect(rpc).toHaveBeenCalledWith("code_symbol_query", expect.objectContaining({ p_mode: "refs" }));
  });

  it("state lookup fails → keeps probing (unknown is not 'no index')", async () => {
    const rpc = mockIndexState("throws");
    await checkDiffWiring("t1", "owner/repo", files);
    expect(rpc).toHaveBeenCalled();
  });
});
