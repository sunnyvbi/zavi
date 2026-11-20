import { describe, it, expect } from "vitest";
import { renderFeedbackClosedEmail } from "../sendFeedbackClosedEmail";

describe("renderFeedbackClosedEmail", () => {
  it("says done, quotes the request and carries the note", () => {
    const r = renderFeedbackClosedEmail({ status: "done", body: "Fix the caption preview", note: "Fixed today." });
    expect(r.subject).toBe("Your Zavi request is done");
    expect(r.text).toContain('You wrote: "Fix the caption preview"');
    expect(r.text).toContain("Zavi team: Fixed today.");
    expect(r.html).toContain("Fixed today.");
  });

  it("says not planned and leaves the note line out when there is none", () => {
    const r = renderFeedbackClosedEmail({ status: "wont_do", body: "Pick the plan day", note: null });
    expect(r.subject).toBe("Update on your Zavi request");
    expect(r.text).toContain("Status: Not planned");
    expect(r.text).not.toContain("Zavi team:");
  });

  it("escapes what the customer and staff typed", () => {
    const r = renderFeedbackClosedEmail({ status: "done", body: "<script>x</script>", note: "<b>hi</b>" });
    expect(r.html).not.toContain("<script>x</script>");
    expect(r.html).not.toContain("<b>hi</b>");
  });
});
