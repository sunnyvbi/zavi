import { describe, it, expect } from "vitest";
import { splitReplyText } from "@/email/quoted-reply";

describe("splitReplyText", () => {
  it("a plain reply is all own words", () => {
    expect(splitReplyText("Raise Meta to $5K.")).toEqual({
      own: "Raise Meta to $5K.",
      quoted: "",
      forwarded: false,
    });
  });

  it("cuts at a Gmail attribution line, including one wrapped over two lines", () => {
    const one = splitReplyText("pause Meta\n\nOn Fri, Sep 26, 2026 at 9:00 AM Zavi <z@z.com> wrote:\n> brief");
    expect(one.own).toBe("pause Meta");
    expect(one.quoted).toContain("> brief");

    const wrapped = splitReplyText(
      "pause Meta\n\nOn Fri, Sep 26, 2026 at 9:00 AM Zavi <\nupcarai@inbox.zaviagent.com> wrote:\n\n> brief",
    );
    expect(wrapped.own).toBe("pause Meta");
    expect(wrapped.quoted).toContain("wrote:");
  });

  it("a reply that itself starts with 'On ...' keeps its words (the attribution is below a blank line)", () => {
    const r = splitReplyText(
      "On it, raise Meta to $50 a day.\n\nOn Fri, Sep 26, 2026 at 9:00 AM Zavi <upcarai@inbox.zaviagent.com> wrote:\n> brief",
    );
    expect(r.own).toBe("On it, raise Meta to $50 a day.");
    expect(r.quoted).toContain("> brief");
    expect(splitReplyText("On second thought, pause Meta.").own).toBe("On second thought, pause Meta.");
  });

  it("moves every > line into quoted, even interleaved", () => {
    const r = splitReplyText("> raise it to $9K\nno, keep it\n> anything else?");
    expect(r.own).toBe("no, keep it");
    expect(r.quoted).toContain("raise it to $9K");
  });

  it("cuts at an Outlook header block and at an Original Message separator", () => {
    const outlook = splitReplyText(
      "yes\n\n________________________________\nFrom: Dana <d@x.com>\nSent: Friday\nTo: me\nSubject: budget\n\nraise it",
    );
    expect(outlook.own).toBe("yes");
    expect(outlook.quoted).toContain("raise it");
    expect(outlook.forwarded).toBe(false);

    const classic = splitReplyText("yes\n-----Original Message-----\nraise it");
    expect(classic.own).toBe("yes");
    expect(classic.forwarded).toBe(false);

    const header = splitReplyText("yes\nFrom: Dana <d@x.com>\nDate: Fri\nSubject: budget\nraise it");
    expect(header.own).toBe("yes");
  });

  it("marks a Gmail or Apple forward, and keeps the forwarded text out of own", () => {
    const gmail = splitReplyText("fyi\n\n---------- Forwarded message ---------\nFrom: v@x.com\nraise it to $9K");
    expect(gmail).toMatchObject({ own: "fyi", forwarded: true });
    expect(gmail.quoted).toContain("$9K");

    const apple = splitReplyText("fyi\n\nBegin forwarded message:\n\nraise it");
    expect(apple.forwarded).toBe(true);
    expect(apple.own).toBe("fyi");
  });

  it("an empty or missing body is empty own text", () => {
    expect(splitReplyText(null).own).toBe("");
    expect(splitReplyText("").own).toBe("");
  });
});
