import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  execCommand: vi.fn(),
  serviceClient: vi.fn(),
}));

vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: mocks.execCommand }));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: vi.fn(async () => "ghs_faketoken"),
  ghInstallationHeaders: vi.fn(() => ({ authorization: "Bearer ghs_faketoken" })),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));

import { buildPrFilesFromSandboxFs, OPERATOR_OPT_IN_BUILDER_CAPS, PRODUCT_BUILD_BUILDER_CAPS } from "../from-sandbox-fs";
import { prProposalProductBuildSchema, prProposalSchema } from "@/agents/engineer/output-schema";
import { callGithubTool } from "@/services/mcp/internal/github";
import { existsSync } from "node:fs";

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x80, 0x81, 0xfe, 0xff, 0x0a, 0x0d, 0x0a,
  0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0xbc, 0x00, 0x00, 0x0a, 0xff, 0xd9,
]);
const PAGE_BEFORE = "export default function Page() {\n  return <main />;\n}\n";
const PAGE_AFTER = 'export default function Page() {\n  return <main style={{ backgroundImage: "url(/images/hero.jpg)" }} />;\n}\n';

let repo = "";

function sh(cmd: string): { stdout: string; stderr: string; exit_code: number; ms: number } {
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exit_code: r.status ?? 1, ms: 0 };
}

function git(args: string): void {
  const r = sh(`cd '${repo}' && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`);
  if (r.exit_code !== 0) throw new Error(r.stderr);
}

type Blob = { content: string; encoding: string };

function installGithubFetch(): Blob[] {
  const blobs: Blob[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const ok = (obj: unknown) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
      if (/\/git\/ref\/heads\//.test(url) && method === "GET") return ok({ object: { sha: "base" } });
      if (/\/git\/blobs$/.test(url)) {
        blobs.push(JSON.parse(String(init!.body)) as Blob);
        return ok({ sha: `blob${blobs.length}` });
      }
      if (/\/git\/trees$/.test(url)) return ok({ sha: "tree" });
      if (/\/git\/commits$/.test(url)) return ok({ sha: "commit" });
      if (/\/git\/refs\/heads\/main$/.test(url) && method === "PATCH") return ok({ object: { sha: "commit" } });
      return { ok: false, status: 500, json: async () => ({}), text: async () => "unexpected" };
    }),
  );
  return blobs;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "binary-asset-"));
  git("init -q -b main");
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app/page.tsx"), PAGE_BEFORE);
  git("add -A");
  git("commit -q -m seed");
  mkdirSync(join(repo, "public/images"), { recursive: true });
  writeFileSync(join(repo, "public/images/hero.jpg"), JPEG);
  writeFileSync(join(repo, "app/page.tsx"), PAGE_AFTER);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.PRAXIS_GITHUB_ORG = "Praxis-build";
  mocks.execCommand.mockReset();
  mocks.execCommand.mockImplementation(async (_sandbox: string, cmd: string) => sh(cmd));
  mocks.serviceClient.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { installation_id: 42 }, error: null }) }) }),
      }),
    }),
  }));
});

describe("a photo the engineer downloads into public/ reaches GitHub byte-for-byte", () => {
  it("builder → product-build proposal → push_to_main commits the exact JPEG bytes and the exact page text", async () => {
    const built = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx", repo_root: repo, caps: PRODUCT_BUILD_BUILDER_CAPS });

    const image = built.files.find((f) => f.path === "public/images/hero.jpg")!;
    expect(image.action).toBe("create");
    expect(image.encoding).toBe("base64");
    expect(image.diff).toContain("Binary files /dev/null and b/public/images/hero.jpg differ");
    expect(built.total_post_image_bytes).toBe(JPEG.length + Buffer.byteLength(PAGE_AFTER));
    expect(built.total_changed_lines).toBe(2);

    const proposal = prProposalProductBuildSchema.parse({
      repo: "praxis-built/mohit-93bd8436",
      base_branch: "main",
      head_branch: "product-builder/refine",
      title: "Use the uploaded photo as the hero",
      files: built.files,
    });

    const blobs = installGithubFetch();
    const res = await callGithubTool({ tenant_id: "t-1", run_id: "r-1" }, "push_to_main", {
      owner: "praxis-built",
      repo: "mohit-93bd8436",
      base_branch: "main",
      title: proposal.title,
      files: proposal.files,
    });
    expect(res.is_error).toBe(false);
    expect(blobs).toHaveLength(2);

    const byContent = blobs.map((b) => Buffer.from(b.content, "base64"));
    expect(byContent.some((b) => b.equals(JPEG))).toBe(true);
    expect(byContent.some((b) => b.toString("utf8") === PAGE_AFTER)).toBe(true);
    expect(blobs.every((b) => b.encoding === "base64")).toBe(true);
  });

  it("the customer-PR proposal schema keeps the encoding flag too, so open_pr cannot re-encode the bytes", async () => {
    const built = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx", repo_root: repo, caps: PRODUCT_BUILD_BUILDER_CAPS });
    const proposal = prProposalSchema.parse({
      repo: "acme/site",
      base_branch: "main",
      head_branch: "engineer/photo",
      title: "Add hero photo",
      files: built.files,
    });
    const image = proposal.files.find((f) => f.path === "public/images/hero.jpg")!;
    expect(image.encoding).toBe("base64");
    expect(Buffer.from(image.content!, "base64").equals(JPEG)).toBe(true);
  });

  it("a text file still goes up as UTF-8, untouched by the binary path", async () => {
    const blobs = installGithubFetch();
    const text = "héllo — ünïcode ✓\n";
    const res = await callGithubTool({ tenant_id: "t-1", run_id: "r-1" }, "push_to_main", {
      owner: "praxis-built",
      repo: "mohit-93bd8436",
      base_branch: "main",
      title: "text",
      files: [{ path: "README.md", action: "modify", content: text }],
    });
    expect(res.is_error).toBe(false);
    expect(Buffer.from(blobs[0]!.content, "base64").toString("utf8")).toBe(text);
  });
});

describe("a photo that fills the builder's post-image cap still passes the dispatch schema", () => {
  const big = () => join(repo, "public/images/big.jpg");

  afterEach(() => {
    if (existsSync(big())) rmSync(big());
  });

  it("product build: the largest image the builder accepts is not rejected later by the proposal schema", async () => {
    const bytes = PRODUCT_BUILD_BUILDER_CAPS.maxPostImageBytes - Buffer.byteLength(PAGE_AFTER) - JPEG.length;
    const photo = Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(bytes - 4, 0x7f)]);
    writeFileSync(big(), photo);

    const built = await buildPrFilesFromSandboxFs({ sandbox_id: "sbx", repo_root: repo, caps: PRODUCT_BUILD_BUILDER_CAPS });
    expect(built.total_post_image_bytes).toBe(PRODUCT_BUILD_BUILDER_CAPS.maxPostImageBytes);
    const image = built.files.find((f) => f.path === "public/images/big.jpg")!;
    expect(image.content!.length).toBeGreaterThan(PRODUCT_BUILD_BUILDER_CAPS.maxPostImageBytes);

    const parsed = prProposalProductBuildSchema.safeParse({
      repo: "praxis-built/mohit-93bd8436",
      base_branch: "main",
      head_branch: "product-builder/refine",
      title: "Use the big photo",
      files: built.files,
    });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues[0])).toBe(true);
    const out = parsed.success ? parsed.data.files.find((f) => f.path === "public/images/big.jpg")! : null;
    expect(Buffer.from(out!.content!, "base64").equals(photo)).toBe(true);
  });

  it("customer PR: an image at the XL post-image cap passes the customer proposal schema", () => {
    const photo = Buffer.alloc(OPERATOR_OPT_IN_BUILDER_CAPS.maxPostImageBytes, 0x7f);
    const parsed = prProposalSchema.safeParse({
      repo: "acme/site",
      base_branch: "main",
      head_branch: "engineer/photo",
      title: "Add hero photo",
      files: [
        {
          path: "public/images/hero.jpg",
          action: "create",
          content: photo.toString("base64"),
          encoding: "base64",
          diff: "diff --git a/public/images/hero.jpg b/public/images/hero.jpg\nnew file mode 100644\nBinary files /dev/null and b/public/images/hero.jpg differ\n",
        },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    const over = prProposalSchema.safeParse({
      repo: "acme/site",
      base_branch: "main",
      head_branch: "engineer/photo",
      title: "Add hero photo",
      files: [
        {
          path: "public/images/hero.jpg",
          action: "create",
          content: Buffer.alloc(OPERATOR_OPT_IN_BUILDER_CAPS.maxPostImageBytes + 3, 0x7f).toString("base64"),
          encoding: "base64",
          diff: "diff --git a/public/images/hero.jpg b/public/images/hero.jpg\nnew file mode 100644\nBinary files /dev/null and b/public/images/hero.jpg differ\n",
        },
      ],
    });
    expect(over.success).toBe(false);
  });
});
