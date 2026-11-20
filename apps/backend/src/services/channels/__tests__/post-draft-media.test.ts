import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ storage: vi.fn(), download: vi.fn(), render: vi.fn(), store: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantStorage: state.storage }));
vi.mock("../post-draft-artwork", () => ({ renderPostArtwork: state.render }));
vi.mock("@/services/chat-images/store-chat-image", () => ({ storeNormalizedChatImage: state.store }));
vi.mock("@/services/media-router/vendors/safe-fetch", () => ({ safeFetchImage: vi.fn() }));
import { renderPostDraftImage } from "../post-draft-media";
const tenant = "11111111-1111-4111-8111-111111111111";
const path = `${tenant}/22222222-2222-4222-8222-222222222222.jpg`;

beforeEach(() => {
  vi.clearAllMocks();
  state.storage.mockReturnValue({ from: (bucket: string) => { expect(bucket).toBe("agent-chat-images"); return { download: state.download }; } });
  state.download.mockResolvedValue({ data: new Blob(["photo"]), error: null });
  state.render.mockResolvedValue(Buffer.from("rendered"));
  state.store.mockResolvedValue({ ok: true, image_path: `${tenant}/rendered.jpg` });
});

describe("saved draft image storage", () => {
  it("uses the guarded tenant scope when downloading and rendering a saved photo", async () => {
    expect(await renderPostDraftImage(tenant, { text: "Caption", thread: null, image_path: path, headline: "New headline" }, {})).toBe(`${tenant}/rendered.jpg`);
    expect(state.storage).toHaveBeenCalledWith(tenant);
    expect(state.download).toHaveBeenCalledWith(path);
    expect(state.store).toHaveBeenCalledWith(tenant, Buffer.from("rendered"));
  });
  it("refuses a different tenant's photo before downloading or rendering it", async () => {
    await expect(renderPostDraftImage("33333333-3333-4333-8333-333333333333", { text: "Caption", thread: null, image_path: path, headline: "New headline" }, {})).rejects.toThrow("Choose an image from this workspace.");
    expect(state.storage).not.toHaveBeenCalled();
    expect(state.render).not.toHaveBeenCalled();
  });
});
