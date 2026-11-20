import { describe, expect, it } from "vitest";
import { declineLateHire, type LateHireDeps } from "../brief-applications";

describe("declineLateHire", () => {
  function deps(approved: boolean) {
    const notes: Array<{ scope_id: string; note: unknown }> = [];
    let status = approved ? "approved" : "rejected";
    const d: LateHireDeps = {
      decline: (async () => {
        if (status !== "approved") return null;
        status = "rejected";
        return { id: "app-2", human_member_id: "hm-2" };
      }) as never,
      loadBrief: (async () => ({ title: "Spring hooks", decline_note: "Thanks, we picked someone else." })) as never,
      businessName: async () => "Sample Co",
      notify: (async (n: { scope_id: string; vars: { note: unknown } }) => {
        notes.push({ scope_id: n.scope_id, note: n.vars.note });
        return { written: true };
      }) as never,
    };
    return { d, notes, get status() { return status; } };
  }

  it("rejects the approved application and sends the business's note, once", async () => {
    const h = deps(true);
    const args = { tenant_id: "t1", brief_id: "b1", application_id: "app-2" };
    expect(await declineLateHire(args, h.d)).toEqual({ declined: true });
    expect(await declineLateHire(args, h.d)).toEqual({ declined: false });
    expect(h.status).toBe("rejected");
    expect(h.notes).toEqual([{ scope_id: "app-2", note: "Thanks, we picked someone else." }]);
  });
});
