import { describe, it, expect } from "vitest";
import { extractDrafts, draftsSchema } from "../drafts";

const validDraft = {
  index: 1,
  title: "Guest can sign up with email + password",
  role: "guest" as const,
  nl_spec: {
    steps: ["Open sign-up", "Enter creds", "Submit"],
    expected_outcome: "Account created and logged in",
    preconditions: ["Not already registered"],
  },
  tags: ["signup", "auth"],
};

function block(body: string): string {
  return `<digest>{"tier4":[]}</digest>\n<drafts>\n${body}\n</drafts>`;
}

describe("extractDrafts", () => {
  it("parses a well-formed drafts block", () => {
    const out = extractDrafts(block(JSON.stringify([validDraft])));
    expect(out).toHaveLength(1);
    expect(out![0].title).toBe(validDraft.title);
    expect(out![0].nl_spec.steps).toHaveLength(3);
  });

  it("parses multiple drafts preserving order", () => {
    const d2 = { ...validDraft, index: 2, title: "Host can create a listing", role: "host" as const };
    const out = extractDrafts(block(JSON.stringify([validDraft, d2])));
    expect(out).toHaveLength(2);
    expect(out![1].index).toBe(2);
    expect(out![1].role).toBe("host");
  });

  it("tolerates a ```json fence inside the block", () => {
    const out = extractDrafts(block("```json\n" + JSON.stringify([validDraft]) + "\n```"));
    expect(out).toHaveLength(1);
  });

  it("returns null when no <drafts> block is present", () => {
    expect(extractDrafts(`<digest>{"tier4":[]}</digest>`)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractDrafts(block("[ not json"))).toBeNull();
  });

  it("returns null when a draft is missing nl_spec (schema miss)", () => {
    const bad = { index: 1, title: "x".repeat(5), role: "guest", tags: [] };
    expect(extractDrafts(block(JSON.stringify([bad])))).toBeNull();
  });

  it("returns null on an empty array (min 1)", () => {
    expect(extractDrafts(block("[]"))).toBeNull();
  });

  it("rejects an invalid role", () => {
    const bad = { ...validDraft, role: "admin" };
    expect(extractDrafts(block(JSON.stringify([bad])))).toBeNull();
  });

  it("draftsSchema defaults preconditions to [] when omitted", () => {
    const noPre = {
      index: 1,
      title: validDraft.title,
      role: "guest",
      nl_spec: { steps: ["step one"], expected_outcome: "works fine" },
      tags: [],
    };
    const parsed = draftsSchema.safeParse([noPre]);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data[0].nl_spec.preconditions).toEqual([]);
  });
});
