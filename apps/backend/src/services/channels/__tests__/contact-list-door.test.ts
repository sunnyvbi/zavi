import { describe, expect, it } from "vitest";
import { asksForAList, withContactListDoor } from "../contact-list-door";

const card = (over: Record<string, unknown> = {}) =>
  ({ id: "c1", status: "pending", executable: false, action_type: "send_message", body: { step: { deliverable: { kind: "email" } } }, ...over }) as never;

const none = { countLists: async () => 0, toolConnected: async () => false };

describe("withContactListDoor", () => {
  it("marks an unstaged email card when there is no list and no tool", async () => {
    const [a] = await withContactListDoor("t1", [card()], none);
    expect((a as { needs_contact_list?: boolean }).needs_contact_list).toBe(true);
  });
  it("marks nothing once a list or an email tool exists", async () => {
    for (const deps of [{ ...none, countLists: async () => 1 }, { ...none, toolConnected: async () => true }]) {
      const [a] = await withContactListDoor("t1", [card()], deps);
      expect(a).not.toHaveProperty("needs_contact_list");
    }
  });
  it("marks nothing when a read fails", async () => {
    const [a] = await withContactListDoor("t1", [card()], { ...none, countLists: async () => { throw new Error("down"); } });
    expect(a).not.toHaveProperty("needs_contact_list");
  });
  it("never marks a staged send, a closed card or a non-email card, and reads nothing without one", async () => {
    let reads = 0;
    const counting = { countLists: async () => (reads++, 0), toolConnected: async () => false };
    const out = await withContactListDoor("t1", [card({ executable: true }), card({ status: "acted" }), card({ action_type: "fix", body: { step: {} } })], counting);
    expect(out.some((a) => "needs_contact_list" in (a as object))).toBe(false);
    expect(reads).toBe(0);
  });
});

describe("asksForAList", () => {
  it("is an unstaged email the founder would send", () => {
    expect(asksForAList(card({ action_type: "other" }))).toBe(true);
    expect(asksForAList(card({ action_type: "fix", body: {} }))).toBe(false);
  });
});
