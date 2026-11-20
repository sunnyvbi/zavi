import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { addRedditCommunity } from "../api";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const answer = (status: number, body: unknown) =>
  apiFetch.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body } as unknown as Response);
const refusal = async () => {
  const err = await addRedditCommunity("smallbusiness").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
};

beforeEach(() => apiFetch.mockReset());

describe("a top-action call the server refuses", () => {
  it("says Already saved for a 409 already_exists, not the raw code", async () => {
    answer(409, { error: "already_exists" });
    const err = await refusal();
    expect(err.message).toBe("Already saved.");
    expect(err.status).toBe(409);
  });

  it("prefers the server's sentence over the code on a 409 that is something else", async () => {
    answer(409, { error: "limit_reached", message: "You can watch up to 30 communities." });
    expect((await refusal()).message).toBe("You can watch up to 30 communities.");
  });

  it("prefers body.message over a nested error message", async () => {
    answer(403, { error: { code: "forbidden", message: "nested" }, message: "Only an owner or an admin can change this." });
    expect((await refusal()).message).toBe("Only an owner or an admin can change this.");
  });

  it("falls back to the nested message, then the string code, then a plain sentence", async () => {
    answer(400, { error: { code: "bad", message: "That subreddit name is not valid." } });
    expect((await refusal()).message).toBe("That subreddit name is not valid.");
    answer(400, { error: "bad_name" });
    expect((await refusal()).message).toBe("bad_name");
    answer(502, {});
    expect((await refusal()).message).toBe("That did not work. Try again.");
  });

  it("ignores an empty message and reads the next one", async () => {
    answer(400, { error: { message: "Name too long." }, message: "" });
    expect((await refusal()).message).toBe("Name too long.");
  });

  it("keeps the body on the error so the plan refusal can still read it", async () => {
    const body = { error: { code: "plan_upgrade_required", tier: "starter" }, message: "Reddit needs the Starter plan ($20/mo)." };
    answer(403, body);
    expect((await refusal()).body).toEqual(body);
  });

  it("does not call a 200 with already_exists in it a refusal", async () => {
    answer(200, { id: "c1", error: "already_exists" });
    await expect(addRedditCommunity("smallbusiness")).resolves.toEqual({ id: "c1", error: "already_exists" });
  });
});
