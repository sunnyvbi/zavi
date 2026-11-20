
import { describe, it, expect } from "vitest";
import { detectInternalMarkers } from "../internal-marker-lint";

const doc = (body: string) => ({
  title: "Chargeback Evidence Packet",
  sections: [{ heading: "Case summary", body_markdown: body }],
});

const kinds = (body: string) =>
  detectInternalMarkers(doc(body)).map((h) => h.kind);

describe("detectInternalMarkers — real leaked strings (2026-07-18)", () => {
  it("catches the not-for-submission marker", () => {
    expect(
      kinds("Fraud fingerprint (context, not for Stripe submission)"),
    ).toContain("not_for_submission_marker");
  });

  it("catches 'For internal review only'", () => {
    expect(kinds("For internal review only — do NOT include in the Stripe submission.")).toContain(
      "not_for_submission_marker",
    );
  });

  it("catches the win band", () => {
    expect(kinds("Recommendation\nFIGHT — Win band: HIGH.")).toContain(
      "win_probability",
    );
    expect(kinds("**Win probability:** Low")).toContain("win_probability");
  });

  it("catches the fight/accept recommendation", () => {
    expect(kinds("Win probability: Low — recommend accepting.")).toContain(
      "fight_accept_recommendation",
    );
    expect(kinds("recommendation: fight")).toContain(
      "fight_accept_recommendation",
    );
  });

  it("catches our own tool status leaking into the document", () => {
    expect(
      kinds(
        "The Stripe dispute-retrieval call was blocked on this run (approval channel unavailable)",
      ),
    ).toContain("tool_or_connector_status");
    expect(kinds("- Operator DB not connected — manual evidence assembly required")).toContain(
      "tool_or_connector_status",
    );
  });

  it("catches self-directed instructions", () => {
    expect(kinds("Do NOT claim CE 3.0 on this submission.")).toContain(
      "self_directed_instruction",
    );
  });

  it("catches the operator task list", () => {
    expect(
      kinds("Log into Stripe Dashboard immediately and confirm the deadline"),
    ).toContain("operator_task_list");
    expect(kinds("Next steps for the operator")).toContain(
      "operator_task_list",
    );
  });

  it("catches agent self-reference", () => {
    expect(
      kinds(
        "No agent action has been taken. This PDF is a review draft; nothing has been submitted to Stripe.",
      ),
    ).toContain("agent_self_reference");
  });
});

describe("detectInternalMarkers — does not fire on legitimate evidence prose", () => {
  const clean = [
    "The cardholder booked, took possession of, and returned the vehicle over a 14-day trip.",
    "The disputed charge passed AVS (address_line1: pass, postal_code: pass) and CVC checks.",
    "Guest check-in 2026-06-13T01:11:17 UTC — mileage 33,000, fuel 90%, 27 photos uploaded.",
    "A $200 security deposit was refunded on 2026-06-29.",
    "The authenticated activity below directly contradicts the 'transaction not authorized' claim.",
    "Attach the in-app chat transcript for the reservation.",
  ];

  it.each(clean)("stays quiet on: %s", (body) => {
    expect(detectInternalMarkers(doc(body))).toEqual([]);
  });
});

describe("detectInternalMarkers — context gating (noise control)", () => {
  it("does NOT fire on 'recommend accepting' in ordinary ops prose", () => {
    expect(
      kinds("Given the margin, we recommend accepting the vendor's offer."),
    ).not.toContain("fight_accept_recommendation");
  });

  it("DOES fire on 'recommend accepting' near dispute vocabulary", () => {
    expect(
      kinds("This chargeback is unlikely to succeed; we recommend accepting."),
    ).toContain("fight_accept_recommendation");
  });

  it("does NOT fire on 'not connected' in ordinary prose", () => {
    expect(
      kinds("The two incidents are not connected to the same root cause."),
    ).not.toContain("tool_or_connector_status");
  });

  it("DOES fire when one of our systems is described as down", () => {
    expect(kinds("Operator DB not connected")).toContain(
      "tool_or_connector_status",
    );
    expect(kinds("manual evidence assembly required")).toContain(
      "tool_or_connector_status",
    );
  });

  it("catches 'do not submit to Stripe' (variant Codex flagged as missed)", () => {
    expect(kinds("Do not submit to Stripe until the deadline is confirmed.")).toContain(
      "not_for_submission_marker",
    );
  });
});

describe("detectInternalMarkers — logo_spec text is a real leak path", () => {
  it("scans logo_spec text elements (rasterized, but visible in the PDF)", () => {
    const hits = detectInternalMarkers({
      title: "Packet",
      sections: [
        {
          heading: "Brand",
          body_markdown: "clean",
          logo_spec: {
            elements: [
              { type: "rect", x: 0, y: 0 },
              { type: "text", content: "internal review only" },
            ],
          },
        },
      ],
    });
    expect(hits.map((h) => h.kind)).toContain("not_for_submission_marker");
    expect(hits.map((h) => h.location)).toContain(
      "section[0].logo_spec.elements[1].content",
    );
  });

  it("tolerates a missing or malformed logo_spec", () => {
    expect(() =>
      detectInternalMarkers({
        title: "t",
        sections: [
          { heading: "h", body_markdown: "b", logo_spec: {} },
          { heading: "h", body_markdown: "b" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("detectInternalMarkers — coverage across the document", () => {
  it("scans title, footer, headings, body, preformatted and table cells", () => {
    const hits = detectInternalMarkers({
      title: "Packet — win probability high",
      footer: "internal review only",
      sections: [
        {
          heading: "Next steps for the operator",
          body_markdown: "clean prose",
          preformatted: "recommendation: accept",
          table: {
            columns: ["Field", "Action"],
            rows: [["ip", "Operator DB not connected"]],
          },
        },
      ],
    });
    const locations = hits.map((h) => h.location);
    expect(locations).toContain("title");
    expect(locations).toContain("footer");
    expect(locations).toContain("section[0].heading");
    expect(locations).toContain("section[0].preformatted");
    expect(locations).toContain("section[0].table.row[0]");
  });

  it("returns an excerpt, never the whole document", () => {
    const long = "x".repeat(5000) + " Win band: HIGH " + "y".repeat(5000);
    const hits = detectInternalMarkers(doc(long));
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt.length).toBeLessThan(200);
  });

  it("returns an empty array for a fully clean document", () => {
    expect(detectInternalMarkers(doc("Evidence of delivery attached."))).toEqual(
      [],
    );
  });
});
