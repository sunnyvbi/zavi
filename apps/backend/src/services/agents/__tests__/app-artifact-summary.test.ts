import { describe, it, expect } from "vitest";
import {
  assembleAppArtifactSummary,
  APP_ARTIFACT_TAG,
  type AppArtifactSummaryInput,
} from "@/services/agents/app-artifact-summary";

describe("assembleAppArtifactSummary", () => {
  it("assembles a full artifact note from all fields", () => {
    const input: AppArtifactSummaryInput = {
      company_name: "Acme Corp",
      idea: "A scheduling app for dog groomers",
      repo_url: "https://github.com/praxis-built/acme",
      github_full_name: "praxis-built/acme",
      default_branch: "main",
      live_url: "https://acme.example.app",
      routes: ["/", "/dashboard", "/api/health"],
      schema_summary: ["bookings(id, customer_id, slot_at)", "customers(id, name)"],
      env_vars: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
      known_limitations: ["No multi-pet support yet"],
      qa_findings: [
        { title: "checkout 500", severity: "P1", detail: "stripe webhook unverified" },
        { title: "missing alt text", severity: "P3" },
      ],
    };
    const out = assembleAppArtifactSummary(input);

    expect(out.title).toBe("Acme Corp — built app");
    expect(out.tags).toEqual([APP_ARTIFACT_TAG]);
    expect(out.body_markdown).toContain("## What it is");
    expect(out.body_markdown).toContain("A scheduling app for dog groomers");
    expect(out.body_markdown).toContain("**Live URL:** https://acme.example.app");
    expect(out.body_markdown).toContain("https://github.com/praxis-built/acme");
    expect(out.body_markdown).toContain("**Default branch:** main");
    expect(out.body_markdown).toContain("## Routes");
    expect(out.body_markdown).toContain("`/dashboard`");
    expect(out.body_markdown).toContain("## DB schema");
    expect(out.body_markdown).toContain("bookings(id, customer_id, slot_at)");
    expect(out.body_markdown).toContain("## Env vars (names only)");
    expect(out.body_markdown).toContain("`STRIPE_SECRET_KEY`");
    expect(out.body_markdown).toContain("## Known limitations");
    expect(out.body_markdown).toContain("No multi-pet support yet");
    expect(out.body_markdown).toContain("## QA ledger");
    expect(out.metadata).toMatchObject({
      kind: "app_artifact",
      company_name: "Acme Corp",
      github_full_name: "praxis-built/acme",
      repo_url: "https://github.com/praxis-built/acme",
      live_url: "https://acme.example.app",
      default_branch: "main",
      route_count: 3,
      qa_finding_count: 2,
    });
  });

  it("orders QA findings by severity (P0 first), stable within a bucket", () => {
    const out = assembleAppArtifactSummary({
      company_name: "X",
      qa_findings: [
        { title: "info-a", severity: "info" },
        { title: "p0-thing", severity: "P0" },
        { title: "p2-b", severity: "P2" },
        { title: "p0-second", severity: "P0" },
      ],
    });
    const body = out.body_markdown;
    const idxP0a = body.indexOf("p0-thing");
    const idxP0b = body.indexOf("p0-second");
    const idxP2 = body.indexOf("p2-b");
    const idxInfo = body.indexOf("info-a");
    expect(idxP0a).toBeGreaterThan(-1);
    expect(idxP0a).toBeLessThan(idxP0b);
    expect(idxP0b).toBeLessThan(idxP2);
    expect(idxP2).toBeLessThan(idxInfo);
  });

  it("omits absent sections entirely (no empty headers, no 'undefined' strings)", () => {
    const out = assembleAppArtifactSummary({ company_name: "Minimal Co" });
    expect(out.title).toBe("Minimal Co — built app");
    expect(out.body_markdown).not.toContain("## What it is");
    expect(out.body_markdown).not.toContain("## Routes");
    expect(out.body_markdown).not.toContain("## DB schema");
    expect(out.body_markdown).not.toContain("## Env vars");
    expect(out.body_markdown).not.toContain("## QA ledger");
    expect(out.body_markdown).not.toContain("## Where it lives");
    expect(out.body_markdown).not.toContain("undefined");
    expect(out.body_markdown).not.toContain("null");
    expect(out.metadata.route_count).toBe(0);
    expect(out.metadata.qa_finding_count).toBe(0);
    expect(out.metadata).not.toHaveProperty("live_url");
  });

  it("falls back to github_full_name as the repo when repo_url is absent", () => {
    const out = assembleAppArtifactSummary({
      company_name: "Y",
      github_full_name: "praxis-built/y",
    });
    expect(out.body_markdown).toContain("## Where it lives");
    expect(out.body_markdown).toContain("**Repo:** praxis-built/y");
    expect(out.metadata.github_full_name).toBe("praxis-built/y");
  });

  it("cleans lists: trims, drops empties, dedupes, clamps count", () => {
    const out = assembleAppArtifactSummary({
      company_name: "Z",
      routes: ["  /a  ", "/a", "", "/b", "/b"],
    });
    expect((out.body_markdown.match(/`\/a`/g) ?? []).length).toBe(1);
    expect((out.body_markdown.match(/`\/b`/g) ?? []).length).toBe(1);
    expect(out.metadata.route_count).toBe(2);
  });

  it("clamps an over-long line and never emits a multi-MB body", () => {
    const huge = "x".repeat(5000);
    const out = assembleAppArtifactSummary({
      company_name: "Big",
      idea: huge,
      routes: Array.from({ length: 500 }, (_, i) => `/r${i}`),
    });
    expect(out.body_markdown).toContain("…");
    expect(out.body_markdown.length).toBeLessThan(20_000);
    expect(out.metadata.route_count as number).toBeLessThanOrEqual(60);
  });

  it("ignores malformed QA findings (no title)", () => {
    const out = assembleAppArtifactSummary({
      company_name: "Q",
      qa_findings: [
        { title: "" },
        // @ts-expect-error — deliberately malformed for the guard test
        { detail: "no title" },
        { title: "real-one", severity: "P1" },
      ],
    });
    expect(out.metadata.qa_finding_count).toBe(1);
    expect(out.body_markdown).toContain("real-one");
  });

  it("is pure — repeated calls with the same input are byte-identical", () => {
    const input: AppArtifactSummaryInput = {
      company_name: "Pure Co",
      idea: "idea",
      live_url: "https://pure.example.app",
      qa_findings: [{ title: "a", severity: "P2" }],
    };
    const a = assembleAppArtifactSummary(input);
    const b = assembleAppArtifactSummary(input);
    expect(a).toEqual(b);
  });
});
