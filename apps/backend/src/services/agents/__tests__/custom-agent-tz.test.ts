import { describe, expect, it } from "vitest";
import { canonicalTz, customTriggerSchema } from "../custom-agents";

describe("schedule timezone (B12)", () => {
  it("a lowercase zone is stored the way the zone database spells it", () => {
    expect(canonicalTz("america/los_angeles")).toBe("America/Los_Angeles");
    const t = customTriggerSchema.parse({ kind: "schedule", cron: "0 9 * * 1-5", tz: "america/new_york" });
    expect(t).toMatchObject({ tz: "America/New_York" });
  });

  it("an unknown zone is refused with the plain message", () => {
    const r = customTriggerSchema.safeParse({ kind: "schedule", cron: "0 9 * * 1-5", tz: "Mars/Olympus" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Unknown timezone "Mars/Olympus". Use a name like America/New_York.');
  });
});
