
import { describe, it, expect } from "vitest";
import { chatVisiblePayload, hasBlockStructure, isThreadUsersOwnTurn, messageText, ownWords, ownerEmailAllowlist, ownerTextsFromRows, ownerTurnTexts } from "@/services/agents/owner-turns";

const prior = [
  { sender_role: "user", body: "we had 1,500 bookings" },
  { sender_role: "assistant", body: "Noted: 1,500 bookings, contact ops@example.com" },
  { sender_role: "user", body: "(attachment)" },
  { sender_role: "user", body: "Thanks!\n> On Mon jane@customer.com wrote: 42 refunds", meta: { via: "email", reply_run_id: "r" } },
  { sender_role: "user", body: "email broker@example-agency.com" },
];

describe("ownerTextsFromRows", () => {
  it("keeps the owner's typed rows and the human current turn", () => {
    expect(ownerTextsFromRows(prior, { sender_role: "user", body: "70% repeat" })).toEqual([
      "we had 1,500 bookings",
      "email broker@example-agency.com",
      "70% repeat",
    ]);
  });

  it("skips assistant rows, attachment-only rows and rows mirrored from email", () => {
    const out = ownerTextsFromRows(prior, null).join(" ");
    expect(out).not.toContain("ops@example.com");
    expect(out).not.toContain("jane@customer.com");
    expect(out).not.toContain("(attachment)");
  });

  it("drops an internal resume turn (the dispatcher passes null for it)", () => {
    expect(ownerTextsFromRows([], null)).toEqual([]);
  });
});

describe("ownerTurnTexts", () => {
  it("reads only the dispatcher's list on a chat run, and fails closed without one", () => {
    expect(ownerTurnTexts({ owner_turn_texts: ["a 1,500", 7, ""] }, "chat")).toEqual(["a 1,500"]);
    expect(ownerTurnTexts({ current_user_text_raw: "x 1,500", prior_messages: [{ role: "user", content: "1,500" }] }, "chat")).toEqual([]);
    expect(ownerTurnTexts(undefined, "chat")).toEqual([]);
  });

  it("ignores a list on any non-chat run (caller-supplied payload)", () => {
    for (const trigger of ["manual", "a2a", "slack", "cron", undefined]) {
      expect(ownerTurnTexts({ owner_turn_texts: ["jane@customer.com"] }, trigger)).toEqual([]);
    }
  });
});

describe("messageText", () => {
  it("keeps file text unless asked not to", () => {
    const content = [{ type: "text", text: "[File: list.csv]\njane@customer.com,42" }, { type: "text", text: "see the list" }];
    expect(messageText(content)).toContain("jane@customer.com");
    expect(messageText(content, { withoutFiles: true })).not.toContain("jane@customer.com");
  });
});

describe("owner trust boundary (security review of owner-turns.ts)", () => {
  const typed = { sender_role: "user", body: "my broker is broker@example-agency.com", meta: {}, content_kind: "text" };

  it("keeps the user's own typed row, edited or not", () => {
    expect(ownerTextsFromRows([typed, { ...typed, body: "old b@x.co", meta: { superseded_at: "2026-10-07T06:35:30Z" } }], null)).toHaveLength(2);
  });

  it("drops a staff console turn, an email mirror, a clarifying-answer card and any unknown row kind", () => {
    const rows = [
      { sender_role: "user", body: "staff@zavi.example", meta: { actor_source: "staff", staff_email: "s@z.co", origin: "staff_console" } },
      { sender_role: "user", body: "fwd: jane@customer.com", meta: { via: "email", reply_run_id: "r" } },
      { sender_role: "user", body: "Answered the clarifying questions.", meta: { clarification_response: { resolved: [{ answer: "jane@customer.com" }] } } },
      { sender_role: "user", body: "x@y.co", meta: { some_future_kind: true } },
      { sender_role: "user", body: "x@y.co", meta: "not an object" },
    ];
    expect(ownerTextsFromRows(rows, null)).toEqual([]);
  });

  it("drops a voice transcript (speech-to-text, not typed)", () => {
    expect(ownerTextsFromRows([{ ...typed, content_kind: "voice_transcript" }], null)).toEqual([]);
  });

  it("drops quoted and fenced blocks pasted into a turn, keeping the user's own words", () => {
    const body = "email my broker broker@example-agency.com\n> On Mon jane@customer.com wrote:\n> refund please\n```\nexport: bob@customer.com\n```\nthanks";
    expect(ownWords(body)).not.toMatch(/jane@|bob@/);
    expect(ownerEmailAllowlist({ owner_turn_texts: ownerTextsFromRows([{ ...typed, body }], null) }, "chat")).toEqual([]);
  });

  it("an unclosed fence drops everything after it (fail closed)", () => {
    expect(ownWords("mine me@x.co\n```\npasted jane@customer.com")).not.toContain("jane@");
  });

  it("counts the rows only when the sender IS the thread's user, through web chat", () => {
    expect(isThreadUsersOwnTurn({ actor_source: "chat", actor_user_id: "u1" }, "u1")).toBe(true);
    expect(isThreadUsersOwnTurn({ actor_source: "chat", actor_user_id: "u2" }, "u1")).toBe(false);
    expect(isThreadUsersOwnTurn({ actor_source: "slack", actor_user_id: "u1" }, "u1")).toBe(false);
    expect(isThreadUsersOwnTurn({ actor_source: "chat", actor_user_id: null }, "u1")).toBe(false);
    expect(isThreadUsersOwnTurn({ actor_source: "system", actor_user_id: null }, null)).toBe(false);
    expect(isThreadUsersOwnTurn(undefined, "u1")).toBe(false);
    expect(isThreadUsersOwnTurn({ actor_source: "chat", actor_user_id: "u1" }, undefined)).toBe(false);
  });
});

describe("owner turns never reach the model (N1)", () => {
  it("chatVisiblePayload drops owner_turn_texts and the transcript keys, keeps the rest", () => {
    const SENTINEL = "OWNER-HISTORY-SENTINEL broker@example-agency.com";
    const visible = chatVisiblePayload(
      {
        thread_id: "t1",
        owner_turn_texts: [SENTINEL],
        prior_messages: [{ role: "user", content: SENTINEL }],
        current_message: SENTINEL,
        current_message_content: [{ type: "text", text: SENTINEL }],
        prior_had_attachments: true,
        recipe_body: "playbook",
      },
      true,
    );
    expect(JSON.stringify(visible)).not.toContain("OWNER-HISTORY-SENTINEL");
    expect(visible).toEqual({ thread_id: "t1" });
    expect(chatVisiblePayload({ recipe_body: "playbook" }, false)).toEqual({ recipe_body: "playbook" });
  });
});

describe("third-party and other-member text is never the owner's", () => {
  it("Slack-inbound text a third party wrote: a Slack run gets no owner list and no owner actor", () => {
    expect(ownerEmailAllowlist({ owner_turn_texts: ["vendor@thirdparty.example"] }, "slack")).toEqual([]);
    expect(isThreadUsersOwnTurn({ actor_source: "slack", actor_user_id: null }, "u1")).toBe(false);
  });

  it("another workspace member's turn: the sender must be the thread's user", () => {
    expect(isThreadUsersOwnTurn({ actor_source: "chat", actor_user_id: "member-2" }, "owner-1")).toBe(false);
  });

  it("tool output or quoted text folded into a user row is not the owner's words", () => {
    const body = "please summarise\n```json\n{\"rows\":[{\"email\":\"jane@customer.com\"}]}\n```\n> bob@customer.com said hi";
    expect(ownerEmailAllowlist({ owner_turn_texts: ownerTextsFromRows([{ sender_role: "user", body }], null) }, "chat")).toEqual([]);
  });
});

describe("ownWords: CommonMark fences (C23-2)", () => {
  const NL = "\n";
  const lines = (...l: string[]) => l.join(NL);
  it.each([
    ["backtick, no indent", lines("mine a@b.co", "```", "jane@customer.com", "```", "after")],
    ["backtick, 1 space", lines("mine a@b.co", " ```", "jane@customer.com", " ```", "after")],
    ["backtick, 3 spaces", lines("mine a@b.co", "   ```js", "jane@customer.com", "   ```", "after")],
    ["tilde, 2 spaces", lines("mine a@b.co", "  ~~~", "jane@customer.com", "  ~~~", "after")],
    ["long opener closes only on as long", lines("mine a@b.co", "````", "```", "jane@customer.com", "````", "after")],
    ["a tilde does not close a backtick fence", lines("mine a@b.co", "```", "~~~", "jane@customer.com", "```", "after")],
    ["a closer with text after it does not close", lines("mine a@b.co", "```", "``` not a closer", "jane@customer.com", "```", "after")],
  ])("drops the fenced block: %s", (_n, body) => {
    const out = ownWords(body);
    expect(out).not.toContain("jane@customer.com");
    expect(out).toContain("mine a@b.co");
    expect(out).toContain("after");
  });

  it("an unclosed indented fence drops the rest", () => {
    expect(ownWords(lines("mine a@b.co", "  ~~~~", "jane@customer.com"))).toBe("mine a@b.co");
  });

  it("4 spaces is not a fence opener; inline triple backticks are not a fence", () => {
    expect(ownWords(lines("    ```", "kept@x.co"))).toContain("kept@x.co");
    expect(ownWords("use ```code``` here me@x.co")).toContain("me@x.co");
  });

  it("drops block quotes at any indent", () => {
    expect(ownWords(lines("mine", "   > jane@customer.com", ">bob@customer.com"))).toBe("mine");
  });
});

describe("email list: a message with block structure contributes nothing (parser differential)", () => {
  const list = (body: string) => ownerEmailAllowlist({ owner_turn_texts: ownerTextsFromRows([{ sender_role: "user", body }], null) }, "chat");
  it.each([
    ["backtick fence", "write broker@example-agency.com\n```\nx\n```"],
    ["indented backtick fence", "write broker@example-agency.com\n      ```"],
    ["tilde fence", "write broker@example-agency.com\n~~~"],
    ["block quote", "write broker@example-agency.com\n> hi"],
    ["indented block quote", "write broker@example-agency.com\n        > hi"],
    ["tab indent", "write broker@example-agency.com\n\tcode"],
    ["4-space indent", "write broker@example-agency.com\n    code"],
    ["<pre>", "write broker@example-agency.com <pre>x</pre>"],
    ["<code>", "write broker@example-agency.com <CODE>x</CODE>"],
    ["<blockquote>", "write broker@example-agency.com <blockquote>x"],
    ["HTML comment", "write broker@example-agency.com <!-- x -->"],
  ])("%s: no address counts", (_n, body) => {
    expect(hasBlockStructure(body)).toBe(true);
    expect(list(body)).toEqual([]);
  });

  it("a plain typed address still counts, across plain lines", () => {
    const body = "please draft a quote request\nto my broker broker@example-agency.com\n  thanks (two-space indent is plain)";
    expect(hasBlockStructure(body)).toBe(false);
    expect(list(body)).toEqual(["broker@example-agency.com"]);
  });

  it("figures still read the message through ownWords (only the email list is all-or-nothing)", () => {
    expect(ownWords("we had 1,500 bookings\n> quoted 900")).toBe("we had 1,500 bookings");
  });
});

describe("view_context never reaches Run context (C24-1)", () => {
  it("chatVisiblePayload drops view_context", () => {
    const visible = chatVisiblePayload({ thread_id: "t1", view_context: [{ description: "Tab", value: "jane@customer.com" }] }, false);
    expect(visible).toEqual({ thread_id: "t1" });
    expect(JSON.stringify(visible)).not.toContain("jane@customer.com");
  });
});
