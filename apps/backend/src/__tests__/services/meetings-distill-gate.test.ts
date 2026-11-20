import { describe, it, expect } from "vitest";
import { gateEphemeralCanonical, type MeetingAtom } from "@/services/meetings/distill";

function atom(over: Partial<MeetingAtom>): MeetingAtom {
  return {
    atom_type: "policy",
    title: "t",
    body: "b",
    owner: null,
    due_date: null,
    confidence: "high",
    memory_class: "canonical",
    source_excerpt: "",
    ...over,
  } as MeetingAtom;
}

describe("gateEphemeralCanonical", () => {
  it("demotes canonical atoms with a baked-in ISO date (judged atom #4)", () => {
    const [r] = gateEphemeralCanonical([
      atom({
        title: "Release cadence: staggered platforms",
        body: "Today (2026-07-06) web and private go live; tomorrow iOS and Android.",
      }),
    ]);
    expect(r.memory_class).toBe("active_ops");
  });

  it("demotes point-in-time status atoms (judged atom #6 / #8 / #1-shape)", () => {
    const cases = [
      "Android has been published to Play Store; iOS and Private web live.",
      "Release must go live by Wednesday afternoon. Try to push tonight.",
      "Yesterday I published the app and it's now live.",
    ];
    for (const body of cases) {
      const [r] = gateEphemeralCanonical([atom({ body })]);
      expect(r.memory_class, body).toBe("active_ops");
    }
  });

  it("demotes single-sprint / single-slice scope atoms (judged atom #13 / #14)", () => {
    const cases = [
      "PRs merged by Monday EOD, QA clear Mon-Tue this sprint.",
      "In this slice we want to implement the entire funnel endpoint.",
    ];
    for (const body of cases) {
      const [r] = gateEphemeralCanonical([atom({ body })]);
      expect(r.memory_class, body).toBe("active_ops");
    }
  });

  it("keeps genuinely durable structural facts canonical (judged atoms #2/#9/#10/#12/#15)", () => {
    const durable = [
      "The tracking plan is the canonical, authoritative source of truth for event implementation.",
      "release_blocker is the standing Jira label marking current-sprint critical blockers.",
      "When code is merged to development it auto-deploys to staging; manual deploy for release.",
      "Users outside the 5 states where insurance is available have the protection plan disabled by default.",
      "Supply auto-syncs between Private Rents and Apkar; host inventory reflects into the marketplace.",
    ];
    for (const body of durable) {
      const [r] = gateEphemeralCanonical([atom({ body })]);
      expect(r.memory_class, body).toBe("canonical");
    }
  });

  it("never touches non-canonical atoms even if they carry markers", () => {
    const [r] = gateEphemeralCanonical([
      atom({ memory_class: "active_ops", body: "blocked until tomorrow" }),
    ]);
    expect(r.memory_class).toBe("active_ops");
    const [w] = gateEphemeralCanonical([
      atom({ memory_class: "watchlist", body: "shipped tonight" }),
    ]);
    expect(w.memory_class).toBe("watchlist");
  });
});
