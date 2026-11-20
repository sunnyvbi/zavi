import { describe, it, expect } from "vitest";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/nextjs-supabase-tailwind/template-files.generated";
// @ts-expect-error plain .mjs ops script, no types
import { classifyFile, classifySite, gitBlobSha, seedSupabaseShas, setDigest } from "../../../scripts/app-supabase-cleanup.mjs";

const SEED = TEMPLATE_FILES["lib/supabase.ts"];
const SEED_PAGE = TEMPLATE_FILES["app/page.tsx"];

function site(files: Record<string, string>) {
  const tree = Object.entries(files).map(([path, content]) => ({ path, sha: gitBlobSha(content), type: "blob" }));
  return classifySite({ tree, files: new Map(Object.entries(files)), seedShas: seedSupabaseShas() });
}

describe("app-supabase-cleanup classifier", () => {
  it("knows the current seed lib/supabase.ts by its git blob sha", () => {
    expect(seedSupabaseShas().has(gitBlobSha(SEED))).toBe(true);
  });

  it("base_only: untouched seed + the seed page's hasSupabaseConfig pill", () => {
    const r = site({ "lib/supabase.ts": SEED, "app/page.tsx": SEED_PAGE, "app/layout.tsx": "export default function L(){}" });
    expect(r.cls).toBe("base_only");
    expect(r.configPill).toBe(true);
  });

  it("base_only: a site with no Supabase reference at all", () => {
    expect(site({ "app/page.tsx": "export default function P(){ return null }" }).cls).toBe("base_only");
  });

  it("auth: the old auth starter's supabase.auth calls", () => {
    const r = site({
      "lib/supabase.ts": SEED,
      "lib/auth.ts": 'import { getSupabase } from "@/lib/supabase";\nexport async function x(){ const c = getSupabase(); await c!.auth.signInWithPassword({email:"",password:""}); }',
    });
    expect(r.cls).toBe("auth");
  });

  it("non_auth_supabase: .from / .storage / .rpc / .channel through the client", () => {
    for (const body of [
      'getSupabase()!.from("todos").select()',
      'getSupabase()!.storage.from("b")',
      'getSupabase()!.rpc("f")',
      'getSupabase()!.channel("c")',
    ]) {
      const r = site({ "lib/supabase.ts": SEED, "app/x.ts": `import { getSupabase } from "@/lib/supabase";\n${body}` });
      expect(r.cls, body).toBe("non_auth_supabase");
    }
  });

  it("non_auth_supabase: a custom wrapper that only hands the client around", () => {
    const r = site({
      "lib/supabase.ts": SEED,
      "lib/data.ts": 'import { getSupabase } from "./supabase";\nexport const client = () => getSupabase();',
    });
    expect(r.cls).toBe("non_auth_supabase");
  });

  it("non_auth_supabase: its own @supabase/supabase-js client or env read", () => {
    expect(site({ "lib/sb.ts": 'import { createClient } from "@supabase/supabase-js";' }).cls).toBe("non_auth_supabase");
    expect(site({ "lib/x.ts": "const u = process.env.NEXT_PUBLIC_SUPABASE_URL; // supabase" }).cls).toBe("non_auth_supabase");
  });

  it("an EDITED seed lib/supabase.ts is never base_only", () => {
    expect(site({ "lib/supabase.ts": SEED + "\n// tweak\n" }).cls).toBe("non_auth_supabase");
  });

  it("node_modules / .next / non-code files are ignored", () => {
    const r = site({
      "lib/supabase.ts": SEED,
      "node_modules/x/index.js": 'require("@supabase/supabase-js")',
      ".next/server/a.js": "supabase.auth.signIn()",
      "README.md": "we use supabase.auth.signUp",
    });
    expect(r.cls).toBe("base_only");
  });

  it("a code file in the tree that was not read makes the site unknown", () => {
    const r = classifySite({
      tree: [{ path: "app/a.ts", sha: "x", type: "blob" }],
      files: new Map(),
      seedShas: seedSupabaseShas(),
    });
    expect(r.cls).toBe("unknown");
  });

  it("classifyFile ignores files that never mention supabase", () => {
    expect(classifyFile("a.ts", "Array.from(x); req.auth.user").signal).toBe(null);
  });

  it("the apply digest pins the exact set, not just its size", () => {
    expect(setDigest(["b", "a"])).toBe(setDigest(["a", "b"]));
    expect(setDigest(["a", "b"])).not.toBe(setDigest(["a", "c"]));
  });
});
