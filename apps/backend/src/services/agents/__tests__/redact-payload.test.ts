import { describe, it, expect } from "vitest";
import { redactStaffOnlyPayload } from "../redact-payload";

describe("redactStaffOnlyPayload", () => {
  it("redacts the operator instruction on a staff-dispatched (FDE) run", () => {
    const run = {
      id: "run-1",
      input_payload_raw: {
        origin: "fde_dispatch",
        task_description:
          "This tenant's brain fabricated a location. Re-ground it from their site before they notice.",
      },
    };

    const out = redactStaffOnlyPayload(run);
    const payload = out.input_payload_raw as Record<string, unknown>;

    expect(payload.redacted).toBe(true);
    expect(JSON.stringify(out)).not.toContain("fabricated");
    expect(JSON.stringify(out)).not.toContain("Re-ground");
  });

  it("never leaks a staff email even if one is somehow in the payload", () => {
    const run = {
      input_payload_raw: {
        origin: "fde_dispatch",
        task_description: "fix their onboarding",
        actor_email: "staff@zavi.internal",
      },
    };

    expect(JSON.stringify(redactStaffOnlyPayload(run))).not.toContain("staff@zavi.internal");
  });

  it("leaves a normal tenant-triggered run completely untouched", () => {
    const run = {
      id: "run-2",
      input_payload_raw: { user_message: "write me a blog post about our new pricing" },
    };

    expect(redactStaffOnlyPayload(run)).toEqual(run);
  });

  it("leaves a chat/slack-origin run untouched", () => {
    const run = { input_payload_raw: { origin: "chat", user_message: "hello" } };
    expect(redactStaffOnlyPayload(run)).toEqual(run);
  });

  it("passes through a null or absent payload without inventing one", () => {
    expect(redactStaffOnlyPayload({ input_payload_raw: null }).input_payload_raw).toBeNull();
    const absent: { input_payload_raw?: unknown } = {};
    expect(redactStaffOnlyPayload(absent).input_payload_raw).toBeUndefined();
  });

  it("keeps the origin visible — the tenant may know staff acted, just not what was said", () => {
    const out = redactStaffOnlyPayload({
      input_payload_raw: { origin: "fde_dispatch", task_description: "internal" },
    });
    expect((out.input_payload_raw as Record<string, unknown>).origin).toBe("fde_dispatch");
  });
});
