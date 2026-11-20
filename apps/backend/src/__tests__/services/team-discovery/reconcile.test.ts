import { describe, it, expect } from "vitest";
import { reconcile, __test } from "@/services/team-discovery/reconcile";
import type { DiscoveredIdentity } from "@/services/team-discovery/types";

const { normalizeEmail, normalizeNameToken } = __test;

const id = (
  provider: "github" | "jira" | "slack",
  external_id: string,
  email: string | null,
  name: string | null,
  is_bot = false,
): DiscoveredIdentity => ({
  provider,
  external_id,
  external_email: email,
  external_display_name: name,
  is_bot,
});

describe("normalizeEmail", () => {
  it("lowercase + trim", () => {
    expect(normalizeEmail(" Alice@Example.COM ")).toBe("alice@example.com");
  });
  it("strips GH noreply suffix", () => {
    expect(normalizeEmail("12345+alice@users.noreply.github.com")).toBeNull();
  });
  it("returns null for empty/null", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("normalizeNameToken", () => {
  it("lowercase first whitespace token", () => {
    expect(normalizeNameToken("Hemachandran S")).toBe("hemachandran");
    expect(normalizeNameToken("Jemis Lakhani")).toBe("jemis");
    expect(normalizeNameToken("jignesh bodarya")).toBe("jignesh");
  });
  it("returns null for empty/null/blank", () => {
    expect(normalizeNameToken(null)).toBeNull();
    expect(normalizeNameToken("")).toBeNull();
    expect(normalizeNameToken("   ")).toBeNull();
  });
  it("rejects single-char tokens (initials)", () => {
    expect(normalizeNameToken("A. Chen")).toBeNull();
    expect(normalizeNameToken("J Doe")).toBeNull();
  });
});

describe("reconcile — Pass 2 name-token clustering (2026-05-17, operator-accepted risk)", () => {
  it("same name across 2 providers, no email → cluster at confidence 0.80", () => {
    const out = reconcile([
      id("github", "alice", null, "Alice Chen"),
      id("slack", "U01ALICE", null, "Alice Chen"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].identities).toHaveLength(2);
    expect(out[0].identities.every((i) => i.confidence === 0.8)).toBe(true);
  });

  it("same first token, different full name → still clusters (Jemis + Jemis Lakhani)", () => {
    const out = reconcile([
      id("slack", "U08HAUZG41L", null, "Jemis"),
      id("jira", "712020:b9cdcef2", null, "Jemis Lakhani"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].display_name).toBe("Jemis Lakhani");
    expect(out[0].identities).toHaveLength(2);
  });

  it("case-insensitive token match (Jignesh + jignesh bodarya)", () => {
    const out = reconcile([
      id("slack", "U08SXQ5MZLY", null, "Jignesh"),
      id("jira", "712020:abc", null, "jignesh bodarya"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].identities).toHaveLength(2);
  });

  it("conflicting non-null emails BLOCKS name-cluster", () => {
    const out = reconcile([
      id("slack", "U_JAY1", "jay1@co.com", "Jay"),
      id("jira", "712020:jay2", "jay2@co.com", "Jay"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("name match across single provider does NOT cluster (need ≥2 providers)", () => {
    const out = reconcile([
      id("slack", "U01", null, "Alex"),
      id("slack", "U02", null, "Alex"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("name match w/ one null email + one set email → cluster, email becomes primary", () => {
    const out = reconcile([
      id("slack", "U01", null, "Furqan"),
      id("jira", "712020:furqan-id", "furqan@co.com", "furqan"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].primary_email).toBe("furqan@co.com");
    expect(out[0].identities).toHaveLength(2);
  });

  it("name match across human + bot stays split (bots always solo)", () => {
    const out = reconcile([
      id("slack", "U_CLAUDE_HUMAN", null, "Claude", false),
      id("slack", "U0AQ202JG3A", null, "Claude", true),
    ]);
    expect(out).toHaveLength(2);
    expect(out.some((c) => c.kind === "bot")).toBe(true);
    expect(out.some((c) => c.kind === "human")).toBe(true);
  });
});

describe("reconcile — email-exact clustering", () => {
  it("two identities with the SAME normalized email across 2 providers → ONE cluster", () => {
    const out = reconcile([
      id("github", "alice-dev", "Alice@Example.com", "Alice Chen"),
      id("slack", "U01ALICE", "alice@example.com", "Alice"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].primary_email).toBe("alice@example.com");
    expect(out[0].identities).toHaveLength(2);
    expect(out[0].identities.every((i) => i.confidence === 1.0)).toBe(true);
  });

  it("three identities, all same email across all 3 providers → ONE cluster", () => {
    const out = reconcile([
      id("github", "alice-dev", "alice@example.com", "Alice Chen"),
      id("slack", "U01ALICE", "alice@example.com", "Alice"),
      id("jira", "5b10a", "alice@example.com", "Alice Chen"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].identities).toHaveLength(3);
  });

  it("two identities with similar names but different emails → 2 separate clusters", () => {
    const out = reconcile([
      id("github", "alice", "alice@example.com", "Alice Chen"),
      id("slack", "U02ALICE", "alice2@example.com", "Alice Chen"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("singleton email (only one identity claims it) → its own cluster", () => {
    const out = reconcile([
      id("github", "bob", "bob@example.com", "Bob"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].primary_email).toBe("bob@example.com");
    expect(out[0].identities).toHaveLength(1);
  });

  it("GH noreply email is nulled (not used as a clustering key)", () => {
    const out = reconcile([
      id("github", "alice", "12345+alice@users.noreply.github.com", "Alice"),
      id("slack", "U01", "12345+alice@users.noreply.github.com", "Bob"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.primary_email === null)).toBe(true);
  });

  it("bot identities stay separate from humans even with same email", () => {
    const out = reconcile([
      id("github", "dependabot[bot]", "dep@example.com", "Dependabot", true),
      id("slack", "U01", "dep@example.com", "Dep Person", false),
    ]);
    expect(out).toHaveLength(2);
    const bot = out.find((c) => c.kind === "bot");
    const human = out.find((c) => c.kind === "human");
    expect(bot).toBeDefined();
    expect(human).toBeDefined();
  });

  it("multiple bots stay as separate single-identity clusters", () => {
    const out = reconcile([
      id("github", "dependabot[bot]", null, "Dependabot", true),
      id("github", "renovate[bot]", null, "Renovate", true),
      id("slack", "USLACKBOT", null, "Slackbot", true),
    ]);
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.kind === "bot")).toBe(true);
  });

  it("empty input → empty output", () => {
    expect(reconcile([])).toEqual([]);
  });

  it("preserves longest non-empty display_name as the canonical name", () => {
    const out = reconcile([
      id("github", "alice", "alice@example.com", "Alice"),
      id("slack", "U01", "alice@example.com", "Alice Chen Wang"),
      id("jira", "5b10", "alice@example.com", "A. Chen"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].display_name).toBe("Alice Chen Wang");
  });

  it("realistic 50-person mixed-evidence scan terminates with sensible cluster count", () => {
    const identities: DiscoveredIdentity[] = [];
    for (let i = 0; i < 30; i++) {
      identities.push(id("github", `user${i}`, `user${i}@co.com`, `User ${i}`));
      identities.push(id("slack", `U${i}`, `user${i}@co.com`, `User ${i}`));
      identities.push(id("jira", `acct${i}`, `user${i}@co.com`, `User ${i}`));
    }
    for (let i = 30; i < 40; i++) {
      identities.push(id("slack", `U${i}`, null, `Lurker ${i}`));
    }
    for (let i = 0; i < 10; i++) {
      identities.push(id("github", `bot${i}[bot]`, null, `Bot ${i}`, true));
    }
    const out = reconcile(identities);
    expect(out.length).toBe(50);
    expect(out.filter((c) => c.kind === "bot").length).toBe(10);
    expect(out.filter((c) => c.identities.length === 3).length).toBe(30);
    expect(out.filter((c) => c.identities.length === 1).length).toBe(20);
  });
});
