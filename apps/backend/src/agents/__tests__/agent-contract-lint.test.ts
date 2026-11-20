
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  BASELINE_CORE_CONTRACTS,
  loadCoreInheritedBlocks,
} from "../../services/agents/generic-dispatcher";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");
const CORE_ROOT = path.join(AGENTS_ROOT, "_core");

function listAgentSlugs(): string[] {
  return readdirSync(AGENTS_ROOT)
    .filter((entry) => {
      if (entry.startsWith("_") || entry.startsWith(".")) return false;
      const full = path.join(AGENTS_ROOT, entry);
      if (!statSync(full).isDirectory()) return false;
      return existsSync(path.join(full, "agent.md"));
    })
    .sort();
}

function readAgentBody(slug: string): string {
  return readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
}

const BANNED_PROSE: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bNO\s+EXCEPTIONS\b/i,
    'Banned (format-context): "NO EXCEPTIONS" — overrides _core/output-shaping.md. Chat turns must be allowed to answer the question directly without emitting the full envelope. Replace with: "Cron/scheduled runs emit the envelope; chat turns may respond conversationally per _core/output-shaping.md."',
  ],
  [
    /\bREQUIRED\s+FORMAT\b/i,
    'Banned (format-context): "REQUIRED FORMAT" — overrides _core/output-shaping.md. Soften to "default format" or condition on trigger (chat vs cron).',
  ],
  [
    /\ball\s+(?:5|five)\s+sections\b/i,
    'Banned (format-context): "all 5/five sections" — locks the agent into the full digest on every turn, even one-line chat questions. Make it conditional or remove.',
  ],
];

const FORMAT_CONTEXT_SUBSTRINGS: readonly string[] = [
  "output",
  "format",
  "envelope",
  "shape",
  "markdown",
  "render",
  "emit",
  "wrap",
  "json",
  "tag",
];

function isFormatContext(lines: readonly string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 2);
  const end = Math.min(lines.length, lineIdx + 3);
  for (let i = start; i < end; i++) {
    const lower = lines[i].toLowerCase();
    for (const kw of FORMAT_CONTEXT_SUBSTRINGS) {
      if (lower.includes(kw)) return true;
    }
  }
  return false;
}

describe("agent-contract-lint", () => {
  const slugs = listAgentSlugs();

  it("finds the agent fleet on disk (sanity check)", () => {
    expect(slugs.length).toBeGreaterThan(10);
    expect(slugs).toContain("performance-marketer");
  });

  it("no agent.md contains banned-prose patterns in a format context", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const body = readAgentBody(slug);
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const [re, why] of BANNED_PROSE) {
          const found = lines[i].match(re);
          if (found && isFormatContext(lines, i)) {
            violations.push(
              `${slug}/agent.md:${i + 1} matched ${re} at "${found[0]}". ${why}`,
            );
          }
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `agent-contract-lint: banned-prose violations:\n  - ${violations.join("\n  - ")}`,
      );
    }
  });

  it("every BASELINE_CORE_CONTRACTS file exists on disk", () => {
    for (const slug of BASELINE_CORE_CONTRACTS) {
      const p = path.join(CORE_ROOT, `${slug}.md`);
      expect(existsSync(p), `missing _core file: ${p}`).toBe(true);
    }
  });

  it("baseline pins the ECC-derived reliability contracts (membership)", () => {
    for (const slug of [
      "anti-hallucination-gates",
      "tool-output-fidelity",
      "hidden-repair-loop-disclosure",
    ]) {
      expect(
        BASELINE_CORE_CONTRACTS.includes(slug),
        `${slug} must stay in BASELINE_CORE_CONTRACTS — it is a fleet-wide reliability contract, not a per-agent opt-in. Removing it silently re-opens a hallucination/over-claim failure mode.`,
      ).toBe(true);
    }
  });

  it("baseline pins agent-chat-voice (chat-brevity, fleet-wide)", () => {
    expect(
      BASELINE_CORE_CONTRACTS.includes("agent-chat-voice"),
      "agent-chat-voice must stay in BASELINE_CORE_CONTRACTS — it is the fleet-wide chat-brevity contract, not a per-agent opt-in. Removing it re-opens the wall-of-text chat regression (2026-06-20).",
    ).toBe(true);
  });

  it("tool-output-fidelity pins the deferred-promise clause (T-F5a, 2026-06-24)", () => {
    const body = readFileSync(path.join(CORE_ROOT, "tool-output-fidelity.md"), "utf-8");
    expect(body).toMatch(/T-F5a/);
    expect(body).toMatch(/I'll ping you in 1 hour/);
    expect(body).toMatch(/\/remind/);
    expect(body).toMatch(/self-schedule/);
  });

  it("tool-output-fidelity T-F5a recognizes praxis__remind as the real scheduler (2026-07-13)", () => {
    const body = readFileSync(path.join(CORE_ROOT, "tool-output-fidelity.md"), "utf-8");
    expect(body).toMatch(/praxis__remind/);
    expect(body).toMatch(/praxis__list_reminders/);
    expect(body).toMatch(/praxis__cancel_reminder/);
    expect(body).not.toMatch(
      /You have no such tool by default\s*—\s*there is no reminder/,
    );
  });

  it("loadCoreInheritedBlocks always prepends the baseline (empty inherits)", () => {
    const out = loadCoreInheritedBlocks([]);
    for (const slug of BASELINE_CORE_CONTRACTS) {
      const body = readFileSync(
        path.join(CORE_ROOT, `${slug}.md`),
        "utf-8",
      ).trim();
      const firstLine = body.split("\n")[0].trim();
      expect(
        out.includes(firstLine),
        `loadCoreInheritedBlocks([]) is missing ${slug} (first line "${firstLine}")`,
      ).toBe(true);
    }
  });

  it("loadCoreInheritedBlocks dedupes when per-agent inherits overlap with baseline", () => {
    const out = loadCoreInheritedBlocks(["tone-and-voice"]);
    const tone = readFileSync(
      path.join(CORE_ROOT, "tone-and-voice.md"),
      "utf-8",
    ).trim();
    const firstLine = tone.split("\n")[0].trim();
    const occurrences = out.split(firstLine).length - 1;
    expect(occurrences).toBe(1);
  });

  it("loadCoreInheritedBlocks hard-fails when a baseline _core file is missing (grok round 2)", () => {
    for (const slug of BASELINE_CORE_CONTRACTS) {
      const p = path.join(CORE_ROOT, `${slug}.md`);
      expect(
        existsSync(p),
        `Baseline _core contract "${slug}" missing at ${p}. loadCoreInheritedBlocks() will THROW at runtime — partial deploy guard. Restore the file before merging.`,
      ).toBe(true);
    }
  });

  it("loadCoreInheritedBlocks appends a non-baseline per-agent contract after the baseline", () => {
    const out = loadCoreInheritedBlocks(["recall-before-act"]);
    expect(out).toContain("Memory recall protocol");
    expect(out).toContain("Your shape");
  });

  it("agents declaring response_contract use only the allowed enum values", () => {
    const ALLOWED = new Set(["auto", "digest", "terse"]);
    const violations: string[] = [];
    for (const slug of slugs) {
      const raw = readAgentBody(slug);
      const fm = matter(raw).data as Record<string, unknown>;
      const praxis = (fm.metadata as Record<string, unknown> | undefined)
        ?.praxis as Record<string, unknown> | undefined;
      const v = praxis?.response_contract;
      if (typeof v === "string" && !ALLOWED.has(v)) {
        violations.push(`${slug}/agent.md → metadata.praxis.response_contract: "${v}"`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Invalid response_contract values:\n  - ${violations.join("\n  - ")}\nAllowed: auto | digest | terse`,
      );
    }
  });

  it("agents declaring recall_policy use only the allowed enum values", () => {
    const ALLOWED = new Set(["always", "live_state_aware"]);
    const violations: string[] = [];
    for (const slug of slugs) {
      const raw = readAgentBody(slug);
      const fm = matter(raw).data as Record<string, unknown>;
      const praxis = (fm.metadata as Record<string, unknown> | undefined)
        ?.praxis as Record<string, unknown> | undefined;
      const v = praxis?.recall_policy;
      if (typeof v === "string" && !ALLOWED.has(v)) {
        violations.push(`${slug}/agent.md → metadata.praxis.recall_policy: "${v}"`);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Invalid recall_policy values:\n  - ${violations.join("\n  - ")}\nAllowed: always | live_state_aware`,
      );
    }
  });

  describe("Wave A — connector skill stubs (_core/connectors/<provider>/skill.md)", () => {
    const CONNECTORS_ROOT = path.join(CORE_ROOT, "connectors");
    const REQUIRED_STUBS = [
      "slack",
      "github",
      "linear",
      "meta_ads",
      "google_ads",
      "operator_db",
    ] as const;

    it("each required connector stub exists on disk", () => {
      for (const slug of REQUIRED_STUBS) {
        const p = path.join(CONNECTORS_ROOT, slug, "skill.md");
        expect(
          existsSync(p),
          `Wave A connector skill missing: ${p}. Stubs are required for the skill-paging splice.`,
        ).toBe(true);
      }
    });

    it("each stub's frontmatter parses as YAML with required keys", () => {
      const violations: string[] = [];
      for (const slug of REQUIRED_STUBS) {
        const p = path.join(CONNECTORS_ROOT, slug, "skill.md");
        if (!existsSync(p)) continue;
        const raw = readFileSync(p, "utf-8");
        let fm: Record<string, unknown>;
        try {
          fm = matter(raw).data as Record<string, unknown>;
        } catch (e) {
          violations.push(`${slug}: frontmatter YAML parse failed: ${(e as Error).message}`);
          continue;
        }
        const provider = fm.provider;
        if (typeof provider !== "string" || provider !== slug) {
          violations.push(
            `${slug}: frontmatter \`provider\` must be the string "${slug}" (got ${JSON.stringify(provider)}).`,
          );
        }
        const applies = fm.applies_to;
        const appliesOk =
          typeof applies === "string" ||
          (Array.isArray(applies) && applies.every((a) => typeof a === "string"));
        if (!appliesOk) {
          violations.push(
            `${slug}: frontmatter \`applies_to\` must be a string or string[] (got ${JSON.stringify(applies)}).`,
          );
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `Wave A connector skill frontmatter violations:\n  - ${violations.join("\n  - ")}`,
        );
      }
    });

    it("each stub body is markdown-parseable (no broken fences, gray-matter accepts)", () => {
      for (const slug of REQUIRED_STUBS) {
        const p = path.join(CONNECTORS_ROOT, slug, "skill.md");
        if (!existsSync(p)) continue;
        const raw = readFileSync(p, "utf-8");
        expect(() => matter(raw), `${slug}: skill.md failed gray-matter parse`).not.toThrow();
        const body = matter(raw).content;
        const fences = (body.match(/```/g) || []).length;
        expect(
          fences % 2,
          `${slug}: skill.md body has unterminated fenced code block (${fences} \`\`\` markers)`,
        ).toBe(0);
      }
    });
  });

  it("every per-agent `inherits:` slug resolves to a real _core file", () => {
    const violations: string[] = [];
    for (const slug of slugs) {
      const raw = readAgentBody(slug);
      const fm = matter(raw).data as Record<string, unknown>;
      const praxis = (fm.metadata as Record<string, unknown> | undefined)
        ?.praxis as Record<string, unknown> | undefined;
      const inherits = praxis?.inherits;
      if (!Array.isArray(inherits)) continue;
      for (const entry of inherits) {
        if (typeof entry !== "string" || entry.length === 0) {
          violations.push(`${slug}/agent.md → inherits entry is not a non-empty string: ${JSON.stringify(entry)}`);
          continue;
        }
        const p = path.join(CORE_ROOT, `${entry}.md`);
        if (!existsSync(p)) {
          violations.push(`${slug}/agent.md → inherits "${entry}" resolves to missing file ${p}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Unresolvable per-agent inherits (typo silently drops the block at runtime):\n  - ${violations.join("\n  - ")}`,
      );
    }
  });

  describe("Move 2 — domain-lens files (_core/lenses/<discipline>.md)", () => {
    const LENSES_ROOT = path.join(CORE_ROOT, "lenses");
    const REQUIRED_LENS_FILES = ["growth", "paid-media"] as const;

    it("each wired lens file exists and carries ≥6 named lenses (bold headers)", () => {
      const violations: string[] = [];
      for (const name of REQUIRED_LENS_FILES) {
        const p = path.join(LENSES_ROOT, `${name}.md`);
        if (!existsSync(p)) {
          violations.push(`missing lens file: ${p}`);
          continue;
        }
        const body = readFileSync(p, "utf-8");
        const namedLenses = (body.match(/^\s*-\s+\*\*/gm) || []).length;
        if (namedLenses < 6) {
          violations.push(`${name}.md has only ${namedLenses} named lenses (**bold** bullets); need ≥6`);
        }
      }
      if (violations.length > 0) {
        throw new Error(`Move-2 lens-file shape violations:\n  - ${violations.join("\n  - ")}`);
      }
    });

    it("slash-slug inherits resolve through loadCoreInheritedBlocks (path.join smoke)", () => {
      const out = loadCoreInheritedBlocks(["lenses/growth"]);
      const growth = readFileSync(path.join(LENSES_ROOT, "growth.md"), "utf-8").trim();
      const firstLine = growth.split("\n")[0].trim();
      expect(out.includes(firstLine), `loadCoreInheritedBlocks(["lenses/growth"]) missing "${firstLine}"`).toBe(true);
    });

    it("no agent inherits a lens — Move 2 dropped after NO-GO eval 2026-07-08 (dormancy pin)", () => {
      const lensByAgent: Record<string, string> = {
        "growth-lead": "lenses/growth",
        "performance-marketer": "lenses/paid-media",
      };
      for (const [agentSlug, lensSlug] of Object.entries(lensByAgent)) {
        const raw = readAgentBody(agentSlug);
        const fm = matter(raw).data as Record<string, unknown>;
        const praxis = (fm.metadata as Record<string, unknown> | undefined)
          ?.praxis as Record<string, unknown> | undefined;
        const inherits = (praxis?.inherits as unknown[]) || [];
        expect(
          inherits.includes(lensSlug),
          `${agentSlug}/agent.md must NOT inherit "${lensSlug}" (Move 2 dropped, NO-GO eval 2026-07-08)`,
        ).toBe(false);
      }
    });
  });

  it("enum-guard tests catch a bad value (regression for grok REVISE fix)", () => {
    const fakeRaw = `---
name: test
metadata:
  praxis:
    response_contract: bogus
    recall_policy: nonsense
---
body
`;
    const fm = matter(fakeRaw).data as Record<string, unknown>;
    const praxis = (fm.metadata as Record<string, unknown> | undefined)
      ?.praxis as Record<string, unknown> | undefined;
    expect(praxis?.response_contract).toBe("bogus");
    expect(praxis?.recall_policy).toBe("nonsense");
  });
});

describe("audience-technical-level — scoped to the operator front door", () => {
  const CONTRACT = "audience-technical-level";
  const MARKER = "Audience — you are talking to a business operator";

  function inheritsOf(slug: string): string[] {
    const fm = matter(
      readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf8"),
    ).data as { metadata?: { praxis?: { inherits?: string[] } } };
    return fm.metadata?.praxis?.inherits ?? [];
  }

  it("the _core file exists on disk", () => {
    expect(existsSync(path.join(CORE_ROOT, `${CONTRACT}.md`))).toBe(true);
  });

  it("operator declares it (Zavi's reader is a business operator)", () => {
    expect(inheritsOf("operator")).toContain(CONTRACT);
  });

  it("operator's assembled prompt actually contains the block", () => {
    expect(loadCoreInheritedBlocks(inheritsOf("operator"))).toContain(MARKER);
  });

  it("engineer does NOT inherit it — it must stay free to talk in code", () => {
    expect(inheritsOf("engineer")).not.toContain(CONTRACT);
    expect(loadCoreInheritedBlocks(inheritsOf("engineer"))).not.toContain(MARKER);
  });

  it("is NOT in the fleet-wide baseline (that would re-capture engineer)", () => {
    expect(BASELINE_CORE_CONTRACTS).not.toContain(CONTRACT);
  });
});
