
import { describe, it, expect } from "vitest";
import { scrubAgentEgress } from "@/services/agents/scrub-agent-egress";
import { ENCODED_EMAIL_RE, OBFUSCATED_EMAIL_RE, emailSpans, emailsIn, keptEmailsFor, replaceEmails } from "@/services/agents/egress-email-provenance";
import { ownerEmailAllowlist, ownerTextsFromRows } from "@/services/agents/owner-turns";
import { recordOwnerFigures, ownerTyped } from "@/services/agents/engine/figure-ledger";

const scrub = (text: string, keepEmails?: readonly string[], agentSlug = "cgo") =>
  scrubAgentEgress(text, { surface: "chat", agentSlug, scrubPii: true, keepEmails }).text;
const ownerList = (...rows: Array<{ sender_role: string; body: string; meta?: unknown }>) =>
  ownerEmailAllowlist({ owner_turn_texts: ownerTextsFromRows(rows, null) }, "chat");

describe("allow-list: only what the owner typed", () => {
  it("keeps an address the owner typed", () => {
    const keep = ownerList({ sender_role: "user", body: "draft an email to my broker at broker@example-agency.com" });
    expect(scrub("To: broker@example-agency.com", keep)).toBe("To: broker@example-agency.com");
  });

  it("keeps it in any letter case, and in a mailto link", () => {
    const keep = ownerList({ sender_role: "user", body: "write to Broker@Example-Agency.com" });
    expect(scrub("[Email](mailto:BROKER@example-agency.com)", keep)).not.toContain("[redacted]");
  });

  it("never keeps an address from a reply, an email mirror or a file the owner attached", () => {
    const keep = ownerList(
      { sender_role: "assistant", body: "Your top customer is jane@customer.com" },
      { sender_role: "user", body: "> On Mon bob@customer.com wrote", meta: { via: "email" } },
      { sender_role: "user", body: "(attachment)" },
    );
    expect(keep).toEqual([]);
    expect(scrub("jane@customer.com, bob@customer.com", keep)).toBe("[redacted], [redacted]");
  });

  it("an address a tool, web page, signed link or image returned is never on the list", () => {
    const keep = ownerList({ sender_role: "user", body: "find their sales contact" });
    for (const addr of ["sales@vendor.io", "jane@customer.com", "export@s3-bucket.example.com"]) {
      expect(scrub(addr, keep)).toBe("[redacted]");
    }
  });

  it("a non-chat run (API, agent-to-agent, Slack, cron) gets an empty list even with a forged payload", () => {
    for (const trigger of ["manual", "a2a", "slack", "cron", undefined]) {
      expect(ownerEmailAllowlist({ owner_turn_texts: ["broker@example-agency.com"] }, trigger)).toEqual([]);
    }
  });

  it("a list with any element that is not exactly one plain address keeps nothing", () => {
    expect(keptEmailsFor("cgo", ["broker@example-agency.com", 7])).toBeUndefined();
    expect(keptEmailsFor("cgo", ["broker@example-agency.com", "x@y.com z@w.com"])).toBeUndefined();
    expect(scrub("broker@example-agency.com", ["broker@example-agency.com", "not an email"])).toBe("[redacted]");
    expect(keptEmailsFor("cgo", ["Broker@Example-Agency.com"])?.has("broker@example-agency.com")).toBe(true);
  });

  it("no list, a malformed list, or another agent: every address is scrubbed", () => {
    expect(scrub("broker@example-agency.com")).toBe("[redacted]");
    expect(keptEmailsFor("cgo", "broker@example-agency.com")).toBeUndefined();
    expect(scrub("broker@example-agency.com", ["broker@example-agency.com"], "pm")).toBe("[redacted]");
    expect(scrub("broker@example-agency.com", [])).toBe("[redacted]");
  });

  it("exact match only: a near match, an encoded or an obfuscated form is never kept", () => {
    const keep = ["broker@example-agency.com"];
    expect(scrub("broker@example-agency.co", keep)).toBe("[redacted]");
    expect(scrub("xbroker@example-agency.com", keep)).toBe("[redacted]");
    expect(scrub("broker@example-agency.com.au", keep)).toBe("[redacted]");
    expect(scrub("?to=broker%40example-agency.com", keep)).toBe("?to=[redacted]");
    expect(emailsIn("broker [at] example-agency [dot] com")).toEqual([]);
    expect(emailsIn("first%2Blast@example.com")).toEqual(["first%2blast@example.com"]);
    expect(scrub("first+last@example.com", emailsIn("first%2Blast@example.com"))).toBe("[redacted]");
  });

  it("always redacts a percent-encoded or bracket-obfuscated address, even one on the list, for every PII agent", () => {
    const keep = ["jane@customer.com"];
    for (const agent of ["cgo", "pm"]) {
      expect(scrub("https://crm.example.com/u?to=jane%40customer.com&x=1", keep, agent)).toBe("https://crm.example.com/u?to=[redacted]&x=1");
      expect(scrub("first%2Blast%40example.com", keep, agent)).toBe("[redacted]");
      expect(scrub("write to jane [at] customer [dot] com", keep, agent)).toBe("write to [redacted]");
      expect(scrub("jane(at)customer.com", keep, agent)).toBe("[redacted]");
      expect(scrub("jane    {at}    customer    (dot)    co (dot) uk", keep, agent)).toBe("[redacted]");
    }
  });

  it("still scrubs phones, cards and SSNs for cgo", () => {
    const out = scrub("broker@example-agency.com, call 415-555-0134, SSN 123-45-6789", ["broker@example-agency.com"]);
    expect(out).toContain("broker@example-agency.com");
    expect(out).not.toContain("415-555-0134");
    expect(out).not.toContain("123-45-6789");
  });
});

describe("ReDoS", () => {
  it("100KB adversarial inputs finish under 50 ms", () => {
    const inputs = [
      "a".repeat(100_000),
      "a".repeat(99_990) + "@b",
      ("x@" + "y.".repeat(10)).repeat(4_000).slice(0, 100_000),
      "%41".repeat(33_333),
      "1 ".repeat(50_000),
      "(123) ".repeat(16_666),
      "415 555 ".repeat(12_500),
      ("a".repeat(60) + " [at] ").repeat(1_500).slice(0, 100_000),
      ("a%41" + " ".repeat(19) + "(at)" + " ".repeat(19)).repeat(2_200).slice(0, 100_000),
      ("x [at] y" + " (dot) z".repeat(9) + " ").repeat(1_000).slice(0, 100_000),
      "a@" + "b".repeat(99_990),
      "a@" + "b.".repeat(49_990),
      "a.".repeat(50_000) + "@x",
      "@".repeat(100_000),
      ("a@b" + ".c".repeat(20)).repeat(2_000).slice(0, 100_000),
    ];
    for (const s of inputs) {
      const t = performance.now();
      const list = ownerEmailAllowlist({ owner_turn_texts: [s] }, "chat");
      const keep = keptEmailsFor("cgo", list);
      replaceEmails(s, (m) => (keep?.has(m.toLowerCase()) ? m : "")).replace(ENCODED_EMAIL_RE, "").replace(OBFUSCATED_EMAIL_RE, "");
      emailsIn(s);
      recordOwnerFigures("redos-run", s);
      ownerTyped("redos-run", "1,500");
      expect(performance.now() - t).toBeLessThan(50);
      scrub(s, list);
    }
  });
});

const MAIN_PII_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

describe("parity with the scrub's original pattern", () => {
  const long64 = "a".repeat(64);
  const corpus = [
    "jane@customer.com",
    "first.last+tag@sub.mail.example.co.uk",
    `${long64}@example.com`,
    `${"x".repeat(300)}@example.com`,
    `jane@${"d".repeat(63)}.${"e".repeat(63)}.${"f".repeat(63)}.com`,
    `jane@example.${"t".repeat(40)}`,
    "jane@example.photography",
    "jane@xn--bcher-kva.example",
    "jane@xn--vermgensberatung-pwb.xn--vermgensberatung-pwb",
    "josé@exämple.com and jose@example.com",
    "用户@例子.广告",
    "<jane@customer.com>",
    "Jane Doe <jane.doe@customer.com>",
    "https://crm.example.com/u/jane@customer.com?x=1",
    "mailto:jane@customer.com",
    "?to=jane@customer.com&cc=bob@customer.com",
    "a@b.cc.d@e.ff",
    "a@bc@d.ee",
    "a@.b.cc",
    "x_y-z%25@a-b.c-d.museum",
    "1234567890@123.45.io",
    "jane@customer.c",
    "(jane@customer.com),bob@customer.com;carl@customer.com.",
  ];
  it("finds exactly the spans the original pattern found", () => {
    for (const text of corpus) {
      const main = [...text.matchAll(MAIN_PII_EMAIL)].map((m) => [m.index!, m.index! + m[0].length]);
      expect(emailSpans(text), text).toEqual(main);
    }
  });
  it("scrubs every address the original pattern scrubbed, for cgo with an empty list and for pm", () => {
    for (const text of corpus) {
      const caught = [...text.matchAll(MAIN_PII_EMAIL)].map((m) => m[0]);
      for (const agent of ["cgo", "pm"]) {
        const out = scrub(text, [], agent);
        for (const addr of caught) expect(out, `${agent}: ${text}`).not.toContain(addr);
      }
    }
  });
});
