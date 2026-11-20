import { describe, it, expect } from "vitest";
import { APP_SETTINGS } from "@/services/settings/registry";

describe("team note settings", () => {
  it("ships ON with the decided caps and retention", () => {
    expect(APP_SETTINGS.team_note_enabled).toMatchObject({ type: "boolean", scope: "per-tenant", defaultValue: true });
    expect(APP_SETTINGS.team_note_max_per_thread).toMatchObject({ type: "number", defaultValue: 1 });
    expect(APP_SETTINGS.team_note_thread_window_hours).toMatchObject({ type: "number", defaultValue: 24 });
    expect(APP_SETTINGS.team_note_max_per_day).toMatchObject({ type: "number", defaultValue: 1 });
    expect(APP_SETTINGS.team_note_stop_offer_after_dismissals).toMatchObject({ type: "number", defaultValue: 1 });
    expect(APP_SETTINGS.team_note_rephrase_similarity).toMatchObject({ type: "number", defaultValue: 0.6 });
    expect(APP_SETTINGS.team_note_retention_days).toMatchObject({ type: "number", defaultValue: 180 });
    expect(APP_SETTINGS.team_note_offer_retention_days).toMatchObject({ type: "number", defaultValue: 400 });
    expect(APP_SETTINGS.team_note_tool_loop_threshold).toMatchObject({ type: "number", scope: "global", defaultValue: 3, min: 2 });
    expect(APP_SETTINGS.team_note_tool_thrash_threshold).toMatchObject({ type: "number", scope: "global", defaultValue: 10, min: 3 });
    expect(APP_SETTINGS).not.toHaveProperty("team_note_judge_alert_per_hour");
  });

  it("retention cannot be configured past 180 days (R3; the DB clamps too)", () => {
    expect(APP_SETTINGS.team_note_retention_days.max).toBe(180);
  });
});
