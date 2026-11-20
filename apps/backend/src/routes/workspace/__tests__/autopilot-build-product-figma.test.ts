import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  startProductBuild: vi.fn(),
  inngestSend: vi.fn(),
  storeIdeaImages: vi.fn(),
  attachOn: false,
  figmaOn: true,
  figmaFlagError: false,
  getSecret: vi.fn(),
  fetch: vi.fn(),
}));

vi.stubGlobal("fetch", (...args: unknown[]) => mocks.fetch(...args));

vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => mocks.getSecret(...a) }));

vi.mock("../../../../workers/client", () => ({
  inngest: { send: (...args: unknown[]) => mocks.inngestSend(...args) },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: vi.fn() }) }) }) }),
  }),
  serviceClient: () => ({ rpc: vi.fn() }),
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string, tenant?: string) => {
    if (key === "build_figma_handoff" && mocks.figmaFlagError) throw new Error("settings down");
    return key === "build_idea_attach" ? mocks.attachOn : key === "build_figma_handoff" ? tenant === "tnt-1" && mocks.figmaOn : false;
  }),
  getStringSetting: vi.fn(async () => null),
  setTenantSetting: vi.fn(async () => undefined),
  getAppSetting: vi.fn(async () => undefined),
}));

vi.mock("@/services/provisioning", () => ({
  provisionCompany: vi.fn(),
  ALL_RESOURCE_KINDS: [
    "repo",
    "host",
    "db",
    "email",
    "stripe",
    "ads",
    "domain",
  ] as const,
}));

vi.mock("@/services/agents/start-product-build", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/agents/start-product-build")
  >("@/services/agents/start-product-build");
  return {
    ...actual,
    startProductBuild: mocks.startProductBuild,
  };
});

vi.mock("@/services/onboarding/idea-reference-images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/onboarding/idea-reference-images")>()),
  storeIdeaImages: mocks.storeIdeaImages,
}));

import sharp from "sharp";
import { postAutopilotBuildProduct } from "../autopilot";
import { getBoolSetting } from "@/services/settings";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

const TOKEN = "figd_ROUTE_secret_token_0987654321";
const FRAME = { file_key: "AbCdEf1234567890XYZ", node_id: "12:34" };
const RENDER = "https://93.184.216.34/render/frame.png";
const idea = "A calm yoga studio site with a class timetable";
const call = async (body: Record<string, unknown>) => {
  const res = mockRes();
  await postAutopilotBuildProduct({ body: { company_name: "Calm", idea, ...body } } as never, res as never);
  return res;
};
const figmaJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const redPng = () =>
  sharp({ create: { width: 6, height: 4, channels: 3, background: { r: 250, g: 0, b: 0 } } }).png().toBuffer();
const figmaCalls = () => mocks.fetch.mock.calls.filter(([u]) => String(u).startsWith("https://api.figma.com/"));

let logSpies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attachOn = true;
  mocks.figmaOn = true;
  mocks.figmaFlagError = false;
  process.env.PRODUCT_BUILDER_ENABLED = "1";
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" });
  mocks.inngestSend.mockResolvedValue({ ids: ["evt"] });
  mocks.getSecret.mockResolvedValue(TOKEN);
  mocks.storeIdeaImages.mockImplementation(async (_t: string, jpegs: Buffer[]) =>
    jpegs.map((_, i) => `https://store.example/signed/${i}.jpg`),
  );
  mocks.startProductBuild.mockResolvedValue({
    conductor_run_id: "run-built",
    target: {},
    provision: { provisioned: [], connected: [], pending_creds: [], failed: [] },
  });
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const s of logSpies) s.mockRestore();
});

describe("POST /api/workspace/autopilot/build-product from a Figma frame", () => {
  it("exports the frame server side with the tenant token and hands only that render to the build", async () => {
    const bytes = await redPng();
    mocks.fetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://api.figma.com/")) return figmaJson({ err: null, images: { "12:34": RENDER } });
      if (u === RENDER) return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
      throw new Error(`unexpected fetch ${u}`);
    });
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty("figma_note");
    expect(mocks.getSecret).toHaveBeenCalledWith("tnt-1", "figma.api_key");
    expect(vi.mocked(getBoolSetting)).toHaveBeenCalledWith("build_figma_handoff", "tnt-1");
    const [tenant, jpegs] = mocks.storeIdeaImages.mock.calls[0] as [string, Buffer[]];
    expect(tenant).toBe("tnt-1");
    expect(jpegs).toHaveLength(1);
    expect(jpegs[0].subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const { data, info } = await sharp(jpegs[0]).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([6, 4]);
    expect(data[0]).toBeGreaterThan(200);
    expect(mocks.startProductBuild.mock.calls[0][0]).toMatchObject({
      tenant_id: "tnt-1",
      reference_images: ["https://store.example/signed/0.jpg"],
    });
  });

  it.each([
    ["403", () => figmaJson({ status: 403, err: "Invalid token" }, 403)],
    ["404", () => figmaJson({ status: 404, err: "Not found" }, 404)],
    ["429", () => figmaJson({ status: 429, err: "Rate limited" }, 429)],
  ])("Figma %s refuses to start without the requested frame and never logs the token", async (_s, reply) => {
    mocks.fetch.mockImplementation(async () => reply());
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
    expect(mocks.storeIdeaImages).not.toHaveBeenCalled();
    const logged = logSpies.flatMap((s) => s.mock.calls).map((a) => JSON.stringify(a)).join("\n");
    expect(logged).toContain("figma");
    expect(logged).not.toContain(TOKEN);
  });

  it("Figma not connected refuses to start and makes no Figma call", async () => {
    mocks.getSecret.mockResolvedValue(null);
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("a stored-frame failure refuses to start without the requested frame", async () => {
    const bytes = await redPng();
    mocks.fetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://api.figma.com/")) return figmaJson({ err: null, images: { "12:34": RENDER } });
      if (u === RENDER) return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
      throw new Error(`unexpected fetch ${u}`);
    });
    mocks.storeIdeaImages.mockResolvedValue([]);
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("a Figma secret read that throws refuses to start", async () => {
    mocks.getSecret.mockRejectedValue(new Error("vault down"));
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("flag off for this tenant refuses the requested import", async () => {
    mocks.figmaOn = false;
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "figma_disabled" } });
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("a client-supplied image URL or non-figma frame is never fetched or built", async () => {
    for (const figma of [
      { ...FRAME, image_url: RENDER },
      { file_key: "https://evil.example/x.png", node_id: "12:34" },
      "https://evil.example/design/AbCdEf1234567890XYZ/x?node-id=12-34",
      { file_key: FRAME.file_key, node_id: "http://169.254.169.254" },
    ]) {
      mocks.startProductBuild.mockClear();
      const res = await call({ figma });
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
      expect(mocks.startProductBuild).not.toHaveBeenCalled();
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.storeIdeaImages).not.toHaveBeenCalled();
  });

  it("a render URL Figma hands back at a private address is refused before it is fetched", async () => {
    mocks.fetch.mockResolvedValue(figmaJson({ err: null, images: { "12:34": "https://169.254.169.254/latest/meta-data" } }));
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
    expect(figmaCalls()).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("a settings read failure refuses to start instead of silently ignoring Figma", async () => {
    mocks.figmaFlagError = true;
    const res = await call({ figma: FRAME });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "figma_unavailable" } });
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("no figma field: no flag read for it and no Figma call", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(getBoolSetting).mock.calls.some(([k]) => k === "build_figma_handoff")).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
