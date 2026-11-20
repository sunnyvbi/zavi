import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  startProductBuild: vi.fn(),
  inngestSend: vi.fn(),
  storeIdeaImages: vi.fn(),
  attachOn: false,
}));

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
  getBoolSetting: vi.fn(async (key: string) => key === "build_idea_attach" && mocks.attachOn),
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

const idea = "A calm yoga studio site with a class timetable";
const pngDataUrl = async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
};
const call = async (body: Record<string, unknown>) => {
  const res = mockRes();
  await postAutopilotBuildProduct({ body: { company_name: "Calm", idea, ...body } } as never, res as never);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attachOn = true;
  process.env.PRODUCT_BUILDER_ENABLED = "1";
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "user-1", access_token: "tok" });
  mocks.inngestSend.mockResolvedValue({ ids: ["evt"] });
  mocks.storeIdeaImages.mockResolvedValue(["https://store.example/signed/a.jpg"]);
  mocks.startProductBuild.mockResolvedValue({
    conductor_run_id: "run-built",
    target: {},
    provision: { provisioned: [], connected: [], pending_creds: [], failed: [] },
  });
});

describe("POST /api/workspace/autopilot/build-product reference images", () => {
  it("stores validated images under the session tenant and hands their URLs to the build", async () => {
    const res = await call({ reference_images: [await pngDataUrl()] });
    expect(res.statusCode).toBe(200);
    const [tenant, jpegs] = mocks.storeIdeaImages.mock.calls[0] as [string, Buffer[]];
    expect(tenant).toBe("tnt-1");
    expect(jpegs[0].subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(mocks.startProductBuild).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "tnt-1", reference_images: ["https://store.example/signed/a.jpg"] }),
    );
  });

  it("503s without starting when any requested image cannot be stored", async () => {
    const one = await pngDataUrl();
    mocks.storeIdeaImages.mockResolvedValue(["https://store.example/signed/a.jpg"]);
    const res = await call({ reference_images: [one, one] });
    expect(res.statusCode).toBe(503);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe("reference_images_unavailable");
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("400 and no build for a non-image, an oversize image, a fourth image or a URL", async () => {
    const one = await pngDataUrl();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    for (const refs of [
      [`data:image/png;base64,${Buffer.from("GIF89a....").toString("base64")}`],
      [`data:image/png;base64,${big.toString("base64")}`],
      [one, one, one, one],
      ["https://evil.example/x.png"],
    ]) {
      const res = await call({ reference_images: refs });
      expect(res.statusCode).toBe(400);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe("invalid_reference_images");
    }
    expect(mocks.storeIdeaImages).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });

  it("flag off ignores the field and builds without references", async () => {
    mocks.attachOn = false;
    const res = await call({ reference_images: ["garbage"] });
    expect(res.statusCode).toBe(200);
    expect(mocks.storeIdeaImages).not.toHaveBeenCalled();
    expect(mocks.startProductBuild.mock.calls[0][0]).not.toHaveProperty("reference_images");
  });
});

describe("POST /api/workspace/autopilot/build-product starting template", () => {
  it("a picked template reaches the build; unfilled [blanks] are refused before the build starts", async () => {
    const filled = "A portfolio site for my ceramics. It shows my best work, a short about, what I offer and an enquiry form.";
    const ok = await call({ idea: filled, template: "portfolio" });
    expect(ok.statusCode).toBe(200);
    expect(mocks.startProductBuild.mock.calls[0][0].site_template).toMatchObject({ id: "portfolio" });
    mocks.startProductBuild.mockClear();
    const refused = await call({ idea: "A portfolio site for my [kind of work]. It shows my best work.", template: "portfolio" });
    expect(refused.statusCode).toBe(400);
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspace/autopilot/build-product look-pick opt-in", () => {
  it("the web build flow's opt-in reaches the build", async () => {
    const res = await call({ await_look_pick: true });
    expect(res.statusCode).toBe(200);
    expect(mocks.startProductBuild.mock.calls[0][0]).toMatchObject({ tenant_id: "tnt-1", await_look_pick: true });
  });

  it("a caller without the opt-in (mobile) or with a non-true value never asks the build to wait", async () => {
    for (const body of [{}, { await_look_pick: "true" }, { await_look_pick: 1 }, { await_look_pick: false }]) {
      mocks.startProductBuild.mockClear();
      const res = await call(body);
      expect(res.statusCode).toBe(200);
      expect(mocks.startProductBuild).toHaveBeenCalledTimes(1);
      expect(mocks.startProductBuild.mock.calls[0][0]).not.toHaveProperty("await_look_pick");
    }
  });
});
