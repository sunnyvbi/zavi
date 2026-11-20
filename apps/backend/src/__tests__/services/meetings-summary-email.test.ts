import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mail = vi.hoisted(() => ({
  sgSend: vi.fn(async (..._a: unknown[]) => undefined),
  logEvent: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
}));
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: mail.sgSend }));
vi.mock("@/services/logging/logEvent", () => ({ logEventConfirmed: mail.logEvent, logEvent: mail.logEvent }));

import { renderMeetingSummary, sendDistillFailureOpsAlert } from "../../services/meetings/summary-email";
import type { MeetingAtom } from "../../services/meetings/distill";
import type { MeetingMinutes } from "../../services/meetings/minutes";

const MINUTES: MeetingMinutes = {
  tldr: "R1 release-day standup. Web + private ship today with a 2 PM cutoff; apps tomorrow.",
  decisions: ["Web + private release today, hard 2 PM cutoff."],
  action_items: [
    { text: "Push all web + private code before the cutoff", owner: "All devs", due_date: "2026-07-07" },
    { text: "Fix DEL-678 private contact page", owner: "Mohit", due_date: null },
  ],
  topics: ["QA bottleneck", "Release cadence"],
  open_questions: ["17 web tickets vs the 2 PM cutoff — trim scope?"],
};

const ATOMS: MeetingAtom[] = [
  {
    atom_type: "blocker",
    title: "Rating flow card not loading",
    body: "",
    owner: "Jay",
    due_date: null,
    confidence: "high",
    memory_class: "active_ops",
    source_excerpt: "it is a blocker",
  },
  {
    atom_type: "spec_fact",
    title: "Subscription credit-score threshold is 550",
    body: "",
    owner: null,
    due_date: null,
    confidence: "medium",
    memory_class: "canonical",
    source_excerpt: "threshold is 550",
  },
];

describe("renderMeetingSummary", () => {
  it("groups atoms by type, counts canonical, never includes transcript excerpts", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-06-11",
      atoms: ATOMS,
      canonical_count: 1,
      approvals_url: "https://www.zaviagent.com/approvals",
    });
    expect(r.subject).toContain("2 item(s)");
    expect(r.html).toContain("Blockers");
    expect(r.html).toContain("Product facts");
    expect(r.html).toContain("Jay");
    expect(r.html).toContain("1 durable fact(s)");
    expect(r.html).not.toContain("it is a blocker");
    expect(r.text).toContain("Rating flow card not loading");
  });

  it("escapes html in atom titles", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-06-11",
      atoms: [{ ...ATOMS[0], title: 'Fix <script>alert("x")</script> path' }],
      canonical_count: 0,
      approvals_url: "https://x",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("renders the nothing-notable variant on zero atoms (not silent)", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-06-11",
      atoms: [],
      canonical_count: 0,
      approvals_url: "https://x",
    });
    expect(r.subject).toContain("nothing notable");
    expect(r.html).toContain("recording is deleted once the transcript is saved in Zavi");
    expect(r.html).not.toMatch(/has been deleted|deleted the recording/);
  });

  it("renders minutes-first when minutes are present (TL;DR / decisions / actions / topics / open questions)", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-07-07",
      atoms: ATOMS,
      canonical_count: 1,
      approvals_url: "https://www.zaviagent.com/approvals",
      minutes: MINUTES,
    });
    expect(r.html).toContain("TL;DR");
    expect(r.html).toContain("Decisions");
    expect(r.html).toContain("Action items");
    expect(r.html).toContain("Topics");
    expect(r.html).toContain("Open questions");
    expect(r.html).toContain("Mohit");
    expect(r.html).toContain("due 2026-07-07");
    expect(r.html).not.toContain("Blockers");
    expect(r.html).not.toContain("Product facts");
    expect(r.html).toContain("1 durable fact(s)");
    expect(r.subject).toContain("1 decision(s), 2 action(s)");
    expect(r.text).toContain("R1 release-day standup");
    expect(r.html).not.toContain("it is a blocker");
  });

  it("falls back to the atoms grouping when minutes is null or empty", () => {
    const nullMin = renderMeetingSummary({
      meeting_date: "2026-07-07",
      atoms: ATOMS,
      canonical_count: 1,
      approvals_url: "https://x",
      minutes: null,
    });
    expect(nullMin.html).toContain("Blockers");

    const emptyMin = renderMeetingSummary({
      meeting_date: "2026-07-07",
      atoms: ATOMS,
      canonical_count: 1,
      approvals_url: "https://x",
      minutes: { tldr: "", decisions: [], action_items: [], topics: [], open_questions: [] },
    });
    expect(emptyMin.html).toContain("Blockers");
  });

  it("escapes html in minutes content", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-07-07",
      atoms: [],
      canonical_count: 0,
      approvals_url: "https://x",
      minutes: { ...MINUTES, tldr: 'Ship <script>alert("x")</script> today' },
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("distill-failure fallback wins even if stale minutes are passed", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-07-07",
      atoms: [],
      canonical_count: 0,
      approvals_url: "https://x",
      minutes: MINUTES,
      distill_failed: true,
    });
    expect(r.subject).toContain("notes pending");
    expect(r.html).toContain("couldn't be generated");
  });

  it("renders the distill-failure fallback (captured, notes pending) — never silent, distinct from nothing-notable", () => {
    const r = renderMeetingSummary({
      meeting_date: "2026-06-21",
      atoms: [],
      canonical_count: 0,
      approvals_url: "https://x",
      distill_failed: true,
    });
    expect(r.subject).toContain("notes pending");
    expect(r.subject).not.toContain("nothing notable");
    expect(r.html).toContain("couldn't be generated");
    expect(r.text).toContain("couldn't be generated");
  });

  const failed = (over: { transcript_saved?: boolean; team_alerted?: boolean }) =>
    renderMeetingSummary({ meeting_date: "2026-10-27", atoms: [], canonical_count: 0, approvals_url: "https://x", distill_failed: true, ...over });

  it("distill failure, transcript saved, team paged: says both, and nothing about the recording", () => {
    const r = failed({ transcript_saved: true, team_alerted: true });
    for (const out of [r.html, r.text]) {
      expect(out).toContain("saved the full transcript in Zavi");
      expect(out).toContain("will reprocess it from the saved transcript");
      expect(out).toContain("Your notes will follow");
      expect(out).not.toMatch(/recording/i);
    }
  });

  it("distill failure, transcript NOT saved: never claims it is saved", () => {
    const r = failed({ transcript_saved: false, team_alerted: true });
    for (const out of [r.html, r.text]) {
      expect(out).not.toContain("saved the full transcript");
      expect(out).toContain("will reprocess the meeting");
      expect(out).not.toMatch(/recording/i);
    }
  });

  it("distill failure, the page did not go out: no claim that the team was told or that notes will follow", () => {
    for (const r of [failed({ transcript_saved: true, team_alerted: false }), failed({})]) {
      for (const out of [r.html, r.text]) {
        expect(out).not.toMatch(/alerted|reprocess|will follow/i);
        expect(out).toContain("couldn't be generated");
      }
    }
    expect(failed({}).text).not.toContain("saved the full transcript");
  });
});

describe("sendDistillFailureOpsAlert", () => {
  const KEY = process.env.SYSTEM_SENDGRID_API_KEY;
  const args = { tenant_id: "t1", meeting_bot_id: "b1", meeting_date: "2026-10-27", error: "llm down" };
  beforeEach(() => {
    mail.sgSend.mockReset();
    mail.sgSend.mockResolvedValue(undefined);
    mail.logEvent.mockReset();
    mail.logEvent.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    if (KEY === undefined) delete process.env.SYSTEM_SENDGRID_API_KEY;
    else process.env.SYSTEM_SENDGRID_API_KEY = KEY;
  });

  it("reports sent only when the email went out, and names the reprocess command for the meeting", async () => {
    process.env.SYSTEM_SENDGRID_API_KEY = "k";
    expect(await sendDistillFailureOpsAlert({ ...args, transcript_saved: true })).toEqual({ sent: true });
    const text = String(mail.sgSend.mock.calls[0][3]);
    expect(text).toContain("notetaker-reprocess.js b1");
    expect(text).toContain("transcript is saved in Zavi");
    expect(mail.logEvent).not.toHaveBeenCalled();
  });

  it("a page that cannot go out (no key, or the send throws) is written to praxis_logs instead, naming the meeting", async () => {
    delete process.env.SYSTEM_SENDGRID_API_KEY;
    expect(await sendDistillFailureOpsAlert(args)).toEqual({ sent: false, logged: true });
    process.env.SYSTEM_SENDGRID_API_KEY = "k";
    mail.sgSend.mockRejectedValue(new Error("sendgrid 503"));
    expect(await sendDistillFailureOpsAlert({ ...args, kind: "transcript_not_saved" })).toEqual({ sent: false, logged: true });
    expect(mail.logEvent.mock.calls.map((c) => (c[0] as { code: string }).code)).toEqual([
      "notetaker.distill_failed_unpaged",
      "notetaker.transcript_not_saved_unpaged",
    ]);
    expect(mail.logEvent.mock.calls[1][0]).toMatchObject({ level: "error", tenant_id: "t1" });
    expect((mail.logEvent.mock.calls[1][0] as { message: string }).message).toContain("meeting_bot_id=b1");
  });

  it("reports when neither the email nor the log row landed, so the caller can retry", async () => {
    delete process.env.SYSTEM_SENDGRID_API_KEY;
    mail.logEvent.mockResolvedValue({ ok: false });
    expect(await sendDistillFailureOpsAlert(args)).toEqual({ sent: false, logged: false });
  });

  it("a transcript that could not be saved says the recording is kept, not deleted", async () => {
    process.env.SYSTEM_SENDGRID_API_KEY = "k";
    await sendDistillFailureOpsAlert({ ...args, kind: "transcript_not_saved", transcript_saved: false });
    expect(String(mail.sgSend.mock.calls[0][1])).toContain("recording kept");
    expect(String(mail.sgSend.mock.calls[0][3])).toContain("KEPT");
  });
});
