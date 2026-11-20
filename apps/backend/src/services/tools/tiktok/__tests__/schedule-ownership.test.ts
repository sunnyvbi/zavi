import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ creator: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock("@/services/connectors/tiktok/api", async original => ({ ...await original<object>(), queryCreatorInfo: m.creator }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({ from: () => ({ insert: m.insert, update: m.update }) }) }));
import { tiktokCreatePostTool, tiktokSchedulePostTool, tiktokUpdateScheduledPostTool } from "../tools";
const tenant = "11111111-1111-1111-1111-111111111111";
const ctx = { tenant_id: tenant, run_trigger: "chat", log: vi.fn() } as never;
const input = { media_type: "VIDEO", title: "A useful product walkthrough", privacy_level: "SELF_ONLY", confirm_user_consent: true,
  scheduled_at: "2099-01-01T10:00:00Z", post_id: "33333333-3333-4333-8333-333333333333",
  video_path: "99999999-9999-9999-9999-999999999999/22222222-2222-2222-2222-222222222222.mp4" };
beforeEach(() => {
  vi.clearAllMocks(); m.creator.mockResolvedValue({ data: { privacy_level_options: ["SELF_ONLY"] } });
  const result = { data: { id: input.post_id, status: "scheduled" }, error: null };
  const chain: Record<string, unknown> = {};
  for (const key of ["eq", "select"]) chain[key] = () => chain;
  chain.single = chain.maybeSingle = async () => result;
  m.insert.mockReturnValue(chain); m.update.mockReturnValue(chain);
});
describe("TikTok scheduling ownership", () => {
  it.each([tiktokCreatePostTool, tiktokSchedulePostTool, tiktokUpdateScheduledPostTool])("$name refuses foreign media before reading the creator or writing a job", async tool => {
    await expect(tool.execute(ctx, input)).rejects.toMatchObject({ code: "tiktok_video_path_foreign" });
    expect(m.creator).not.toHaveBeenCalled(); expect(m.insert).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
});

it.each([tiktokCreatePostTool, tiktokSchedulePostTool, tiktokUpdateScheduledPostTool])("$name accepts owned media and retains the scheduled-row guard", async tool => {
  const result = { data: { id: input.post_id, status: "scheduled" }, error: null };
  const eq = vi.fn();
  const chain = { eq, select: vi.fn(), single: async () => result, maybeSingle: async () => result };
  eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  m.insert.mockReturnValue(chain); m.update.mockReturnValue(chain);
  const owned = { ...input, video_path: `${tenant}/22222222-2222-2222-2222-222222222222.mp4` };
  await expect(tool.execute(ctx, owned)).resolves.toMatchObject({ id: input.post_id });
  const write = tool === tiktokUpdateScheduledPostTool ? m.update : m.insert;
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ video_path: owned.video_path }) }));
  if (tool === tiktokUpdateScheduledPostTool) expect(eq).toHaveBeenCalledWith("status", "scheduled");
});
