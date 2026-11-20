import { describe, expect, it } from "vitest";
import { draftBlocker } from "../draft-blocker";

const LIST = "mc_target";
const read = (body: unknown, status = "ok") => ({
  name: "mcp__server__email_campaign__list_audiences",
  status,
  input_preview: "{}",
  output_preview: JSON.stringify([{ type: "text", text: JSON.stringify(body) }]),
});
const run = (calls: unknown[], route = "mailchimp") => ({
  status: "success",
  finished_at: "2026-10-21T16:30:00Z",
  payload: { email_plan: { route, list_id: LIST } },
  tool_calls: calls,
});
const every = (over: Record<string, unknown>) => ({ unreadable: [], notes: [], audiences: [], ...over });
const row = (tool: string, id: string, member_count = 5) => ({ tool, id, name: "A list", member_count });

describe("draftBlocker reading a list_audiences result that covers every tool", () => {
  it("the planned list is there on its route: nothing blocks", () => {
    expect(draftBlocker(run([read(every({ audiences: [row("klaviyo", "other"), row("mailchimp", LIST)] }))]))).toBeNull();
  });

  it("the planned list is gone from its route: blocked as missing", () => {
    expect(draftBlocker(run([read(every({ audiences: [row("mailchimp", "other"), row("klaviyo", "else")] }))]))).toBe("email_audience_missing");
  });

  it("the same id on another tool does not satisfy the route", () => {
    expect(draftBlocker(run([read(every({ audiences: [row("mailchimp", "other"), row("klaviyo", LIST)] }))]))).toBe("email_audience_missing");
  });

  it("the route was unreadable: that is no proof the list is gone, whatever the other tool held", () => {
    const out = every({ audiences: [row("klaviyo", "else")], unreadable: [{ tool: "mailchimp", message: "Mailchimp could not be read: down" }] });
    expect(draftBlocker(run([read(out)]))).toBeNull();
  });

  it("an unreadable latest read falls back to the earlier one that did read the route", () => {
    const earlier = read({ tool: "mailchimp", audiences: [{ id: "other", name: "A", member_count: 3 }] });
    const later = read(every({ audiences: [row("klaviyo", "else")], unreadable: [{ tool: "mailchimp", message: "x" }] }));
    expect(draftBlocker(run([earlier, later]))).toBe("email_audience_missing");
  });

  it("the route's own list read was cut short: a list off the page is not missing", () => {
    const out = every({ audiences: [row("mailchimp", "other")], notes: [{ tool: "mailchimp", note: "Mailchimp has more lists than Zavi reads at once" }] });
    expect(draftBlocker(run([read(out)]))).toBeNull();
  });

  it("another tool's cut-short note does not excuse the route", () => {
    const out = every({ audiences: [row("mailchimp", "other")], notes: [{ tool: "klaviyo", note: "Klaviyo has more lists" }] });
    expect(draftBlocker(run([read(out)]))).toBe("email_audience_missing");
  });

  it("the route has no lists at all: blocked as missing", () => {
    const out = every({ audiences: [row("klaviyo", "else")], notes: [{ tool: "mailchimp", note: "Mailchimp has no lists yet" }] });
    expect(draftBlocker(run([read(out)]))).toBe("email_audience_missing");
  });

  it("the planned list is empty on its route: blocked as empty", () => {
    expect(draftBlocker(run([read(every({ audiences: [row("klaviyo", "else"), row("mailchimp", LIST, 0)] }))]))).toBe("email_audience_empty");
  });

  it("the same id empty on ANOTHER tool does not block the route", () => {
    expect(draftBlocker(run([read(every({ audiences: [row("klaviyo", LIST, 0), row("mailchimp", LIST, 5)] }))]))).toBeNull();
  });

  it("the one-tool shape still reads as it did", () => {
    expect(draftBlocker(run([read({ tool: "mailchimp", audiences: [{ id: LIST, name: "A", member_count: 3 }] })]))).toBeNull();
    expect(draftBlocker(run([read({ tool: "mailchimp", audiences: [{ id: "other", name: "A", member_count: 3 }] })]))).toBe("email_audience_missing");
    expect(draftBlocker(run([read({ tool: "mailchimp", audiences: [{ id: LIST, name: "A", member_count: 0 }] })]))).toBe("email_audience_empty");
    expect(draftBlocker(run([read({ tool: "klaviyo", audiences: [{ id: "other", name: "A", member_count: 3 }] })]))).toBeNull();
  });
});
