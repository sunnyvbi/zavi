
import { describe, it, expect, afterEach } from "vitest";
import {
  decideOperatorTool,
  classifyExternalWriteIntent,
  newToolCounters,
  OPERATOR_BUDGET_CAPS,
  OPERATOR_HANDOFF_TOOLS,
  OPERATOR_WRITE_TOOLS,
  type ClassifyT,
  type OperatorPolicyInput,
} from "../operator-policy";

function mkClassify(over: Partial<ClassifyT> = {}): ClassifyT {
  return {
    tier: over.tier ?? "tier2",
    confidence: over.confidence ?? 0.9,
    evidence_needed: over.evidence_needed ?? [],
    target_specialist: over.target_specialist,
  };
}

function mkInput(
  over: Partial<OperatorPolicyInput> = {},
): OperatorPolicyInput {
  return {
    classify: "classify" in over ? over.classify : mkClassify(),
    tool_name: over.tool_name ?? "memory__search",
    run_id: over.run_id ?? "run-test-uuid",
    iter: over.iter ?? 0,
    counters: over.counters ?? newToolCounters(),
    ...("latest_user_text" in over
      ? { latest_user_text: over.latest_user_text }
      : {}),
    ...("failclosed_mode" in over ? { failclosed_mode: over.failclosed_mode } : {}),
    ...("failclosed_bypassed" in over
      ? { failclosed_bypassed: over.failclosed_bypassed }
      : {}),
    ...("on_would_block" in over ? { on_would_block: over.on_would_block } : {}),
    ...("mention_target" in over ? { mention_target: over.mention_target } : {}),
  };
}

const SEARCH_CAP = OPERATOR_BUDGET_CAPS.get("github__search_code")!;

describe("operator-policy: surface taxonomy is wired correctly", () => {
  it("handoff tools include both single + parallel", () => {
    expect(OPERATOR_HANDOFF_TOOLS.has("praxis__handoff")).toBe(true);
    expect(OPERATOR_HANDOFF_TOOLS.has("praxis__handoff_parallel")).toBe(true);
  });

  it("memory_write is on the write tool list", () => {
    expect(OPERATOR_WRITE_TOOLS.has("memory__write")).toBe(true);
  });

  it("praxis__action is on the write tool list", () => {
    expect(OPERATOR_WRITE_TOOLS.has("praxis__action")).toBe(true);
  });

  it("github__search_code has a budget cap of 12 (5→8 2026-07-17, 8→12 2026-08-29)", () => {
    expect(OPERATOR_BUDGET_CAPS.get("github__search_code")).toBe(12);
  });

  it("memory__write has a budget cap of 10 (slice 6)", () => {
    expect(OPERATOR_BUDGET_CAPS.get("memory__write")).toBe(10);
  });

  it("github__read_file has a budget cap of 12 (2026-07-17: 8→12, misses are refunded)", () => {
    expect(OPERATOR_BUDGET_CAPS.get("github__read_file")).toBe(12);
    expect(OPERATOR_BUDGET_CAPS.get("github__grep")).toBe(8);
  });

  it("read_file budget-exhausted recovery says ANSWER, not loop, not handoff, not absence", () => {
    const counters = newToolCounters();
    const classify = mkClassify({ tier: "tier2", evidence_needed: ["github__*"] });
    let body = "";
    for (let i = 0; i < 13; i++) {
      const d = decideOperatorTool({
        classify,
        tool_name: "github__read_file",
        run_id: "read-cap",
        iter: i,
        counters,
      });
      if (!d.allow) body = d.synthetic_tool_result ?? "";
    }
    expect(body).toMatch(/STOP reading and answer/i);
    expect(body).toMatch(/do NOT keep retrying/i);
    expect(body).toMatch(/do NOT route a read-only lookup/i);
    expect(body).toMatch(/UNVERIFIED/i);
    expect(body).toMatch(/never.*absent|not.*absent/i);
  });

  it("read tools are NOT on the write list", () => {
    expect(OPERATOR_WRITE_TOOLS.has("memory__search")).toBe(false);
    expect(OPERATOR_WRITE_TOOLS.has("operator_db__catalog")).toBe(false);
    expect(OPERATOR_WRITE_TOOLS.has("github__search_code")).toBe(false);
    expect(OPERATOR_WRITE_TOOLS.has("github__read_file")).toBe(false);
    expect(OPERATOR_WRITE_TOOLS.has("jira__search")).toBe(false);
    expect(OPERATOR_WRITE_TOOLS.has("stripe__list_charges")).toBe(false);
  });

  it("handoff tools are NOT on the write list (they have special-case path)", () => {
    expect(OPERATOR_WRITE_TOOLS.has("praxis__handoff")).toBe(false);
    expect(OPERATOR_WRITE_TOOLS.has("praxis__handoff_parallel")).toBe(false);
  });
});

describe("operator-policy: tier1 / tier2 happy paths", () => {
  it("tier2 read tool → allow", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "memory__search",
      }),
    );
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("ok");
  });

  it("tier1 read tool → allow", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier1" }),
        tool_name: "operator_db__catalog",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier2 single-direct-action write (praxis__action) → allow", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier2 memory_write → allow (operator's curated learning surface)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "memory__write",
      }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("operator-policy: tier3 = handoff-only for writes", () => {
  it("tier3 + praxis__action → deny tier3_write_denied", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          target_specialist: "trust-safety",
        }),
        tool_name: "praxis__action",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("tier3_write_denied");
      expect(d.synthetic_tool_result).toMatch(/TIER 3 WRITE DENIED/);
      expect(d.synthetic_tool_result).toMatch(/trust-safety/);
    }
  });

  it("tier3 + memory_write → deny", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3" }),
        tool_name: "memory__write",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("tier3_write_denied");
  });

  it("tier3 + jira__create_issue → deny (future-proof, op doesn't have it today)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3" }),
        tool_name: "jira__create_issue",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("tier3_write_denied");
  });

  it("tier3 + praxis__handoff → ALLOW (the whole point of tier3)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          target_specialist: "engineer",
        }),
        tool_name: "praxis__handoff",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier3 + praxis__handoff_parallel → ALLOW", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3" }),
        tool_name: "praxis__handoff_parallel",
      }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("operator-policy: tier1 lookup-handoff is denied (read it yourself)", () => {
  for (const tool of ["praxis__handoff", "praxis__handoff_parallel"]) {
    it(`tier1 + ${tool} → DENY with read-it-yourself recovery`, () => {
      const d = decideOperatorTool(
        mkInput({
          classify: mkClassify({ tier: "tier1" }),
          tool_name: tool,
        }),
      );
      expect(d.allow).toBe(false);
      if (!d.allow) {
        expect(d.reason).toBe("tier1_lookup_handoff_denied");
        expect(d.synthetic_tool_result).toMatch(/github__read_file/);
        expect(d.synthetic_tool_result).toMatch(/HANDOFF DENIED/);
      }
    });
  }

  it("tier1 + a normal read tool (memory__search) → still ALLOW", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier1" }),
        tool_name: "memory__search",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier2 + praxis__handoff → still ALLOW (only tier1 is read-only)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__handoff",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier3 + missing target_specialist still denies the write (it's the action that's denied, not the routing)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3", target_specialist: undefined }),
        tool_name: "praxis__action",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("tier3_write_denied");
      expect(d.synthetic_tool_result).toMatch(/relevant specialist/);
    }
  });
});

describe("operator-policy: tier3 read gating via evidence_needed[]", () => {
  it("tier3 + read tool NOT in evidence_needed → deny", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          evidence_needed: ["operator_db__catalog"],
        }),
        tool_name: "memory__search",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("tier3_read_not_in_evidence");
      expect(d.synthetic_tool_result).toMatch(/TIER 3 READ DENIED/);
    }
  });

  it("tier3 + read tool listed by exact name in evidence_needed → allow", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          evidence_needed: ["memory__search"],
        }),
        tool_name: "memory__search",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier3 + read tool covered by wildcard `server__*` → allow", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          evidence_needed: ["web_fetch__*"],
        }),
        tool_name: "web_fetch__fetch",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("tier3 + wildcard does NOT leak across server prefixes", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          evidence_needed: ["web_fetch__*"],
        }),
        tool_name: "github__search_code",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("tier3_read_not_in_evidence");
  });

  it("tier3 + empty evidence_needed + read tool → deny (forces handoff)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3", evidence_needed: [] }),
        tool_name: "operator_db__catalog",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("tier3_read_not_in_evidence");
  });

  it("tier3 + multiple evidence_needed entries → matches any of them", () => {
    const base = mkInput({
      classify: mkClassify({
        tier: "tier3",
        evidence_needed: [
          "operator_db__catalog",
          "memory__search",
          "web_fetch__*",
        ],
      }),
    });
    expect(
      decideOperatorTool({ ...base, tool_name: "operator_db__catalog" }).allow,
    ).toBe(true);
    expect(decideOperatorTool({ ...base, tool_name: "memory__search" }).allow).toBe(
      true,
    );
    expect(decideOperatorTool({ ...base, tool_name: "web_fetch__fetch" }).allow).toBe(
      true,
    );
    expect(
      decideOperatorTool({ ...base, tool_name: "stripe__list_charges" }).allow,
    ).toBe(false);
  });
});

describe("operator-policy: missing classify on iter 0 fails closed for writes", () => {
  it("iter 0 + no classify + memory_write → deny", () => {
    const d = decideOperatorTool(
      mkInput({ classify: undefined, tool_name: "memory__write", iter: 0 }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("missing_classify_fail_closed");
      expect(d.synthetic_tool_result).toMatch(/classify/);
      expect(d.synthetic_tool_result).toMatch(/WRITE DENIED/);
    }
  });

  it("iter 0 + no classify + praxis__action → deny", () => {
    const d = decideOperatorTool(
      mkInput({ classify: undefined, tool_name: "praxis__action", iter: 0 }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("missing_classify_fail_closed");
  });

  it("iter 0 + no classify + read tool → allow (reads always open)", () => {
    const d = decideOperatorTool(
      mkInput({ classify: undefined, tool_name: "memory__search", iter: 0 }),
    );
    expect(d.allow).toBe(true);
  });

  it("iter 0 + no classify + handoff tool → allow (safest write surface)", () => {
    const d = decideOperatorTool(
      mkInput({ classify: undefined, tool_name: "praxis__handoff", iter: 0 }),
    );
    expect(d.allow).toBe(true);
  });

  it("iter > 0 + no classify + write tool → allow (slice 2 prepend reader will hydrate)", () => {
    const d = decideOperatorTool(
      mkInput({ classify: undefined, tool_name: "memory__write", iter: 1 }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("operator-policy: confidence floor backstop", () => {
  it("classify.confidence below floor + write → deny", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2", confidence: 0.4 }),
        tool_name: "memory__write",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("low_confidence_fail_closed");
      expect(d.synthetic_tool_result).toMatch(/0\.40/);
      expect(d.synthetic_tool_result).toMatch(/0\.6/);
    }
  });

  it("classify.confidence at floor exactly → allow", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2", confidence: 0.6 }),
        tool_name: "memory__write",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("classify.confidence below floor + read → allow (reads are cheap, low-bar)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2", confidence: 0.1 }),
        tool_name: "memory__search",
      }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("operator-policy: github__search_code budget cap", () => {
  it("first 5 calls allowed", () => {
    const counters = newToolCounters();
    for (let i = 0; i < 5; i++) {
      const d = decideOperatorTool(
        mkInput({
          classify: mkClassify({ tier: "tier2" }),
          tool_name: "github__search_code",
          counters,
        }),
      );
      expect(d.allow).toBe(true);
    }
    expect(counters.get("github__search_code")).toBe(5);
  });

  it("the call after the cap is denied with a budget-exhausted reason", () => {
    const counters = newToolCounters();
    for (let i = 0; i < SEARCH_CAP; i++) {
      decideOperatorTool(
        mkInput({
          classify: mkClassify({ tier: "tier2" }),
          tool_name: "github__search_code",
          counters,
        }),
      );
    }
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "github__search_code",
        counters,
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("github_search_code_budget_exhausted");
      expect(d.synthetic_tool_result).toMatch(/BUDGET EXHAUSTED/);
      expect(d.synthetic_tool_result).toMatch(/read_file/);
    }
  });

  it("denied calls do NOT bump the counter", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", SEARCH_CAP);
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "github__search_code",
        counters,
      }),
    );
    expect(d.allow).toBe(false);
    expect(counters.get("github__search_code")).toBe(SEARCH_CAP);
  });

  it("budget gate runs BEFORE classify gate (no tier3 evasion)", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", SEARCH_CAP);
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({
          tier: "tier3",
          evidence_needed: ["github__search_code"],
        }),
        tool_name: "github__search_code",
        counters,
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow)
      expect(d.reason).toBe("github_search_code_budget_exhausted");
  });

  it("other tools share NO counter with github__search_code", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", 5);
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "github__read_file",
        counters,
      }),
    );
    expect(d.allow).toBe(true);
    expect(counters.get("github__read_file")).toBe(1);
    expect(counters.get("github__search_code")).toBe(5);
  });
});

describe("operator-policy: counter bookkeeping invariants", () => {
  it("allow increments by exactly 1", () => {
    const counters = newToolCounters();
    decideOperatorTool(mkInput({ tool_name: "memory__search", counters }));
    decideOperatorTool(mkInput({ tool_name: "memory__search", counters }));
    expect(counters.get("memory__search")).toBe(2);
  });

  it("deny does not bump (tier3_write_denied case)", () => {
    const counters = newToolCounters();
    decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3" }),
        tool_name: "memory__write",
        counters,
      }),
    );
    expect(counters.get("memory__write")).toBeUndefined();
  });

  it("deny does not bump (missing_classify case)", () => {
    const counters = newToolCounters();
    decideOperatorTool(
      mkInput({
        classify: undefined,
        tool_name: "praxis__action",
        iter: 0,
        counters,
      }),
    );
    expect(counters.get("praxis__action")).toBeUndefined();
  });

  it("deny does not bump (low_confidence case)", () => {
    const counters = newToolCounters();
    decideOperatorTool(
      mkInput({
        classify: mkClassify({ confidence: 0.2 }),
        tool_name: "memory__write",
        counters,
      }),
    );
    expect(counters.get("memory__write")).toBeUndefined();
  });

  it("counters survive across different tool names without cross-pollination", () => {
    const counters = newToolCounters();
    for (let i = 0; i < 3; i++) {
      decideOperatorTool(mkInput({ tool_name: "memory__search", counters }));
      decideOperatorTool(
        mkInput({ tool_name: "operator_db__catalog", counters }),
      );
    }
    expect(counters.get("memory__search")).toBe(3);
    expect(counters.get("operator_db__catalog")).toBe(3);
  });
});

describe("operator-policy: tool name normalization", () => {
  it("strips mcp__ prefix before matching", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", SEARCH_CAP);
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "mcp__github__search_code",
        counters,
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow)
      expect(d.reason).toBe("github_search_code_budget_exhausted");
  });

  it("non-prefixed tool names pass through unchanged", () => {
    const counters = newToolCounters();
    const d = decideOperatorTool(
      mkInput({ tool_name: "github__search_code", counters }),
    );
    expect(d.allow).toBe(true);
    expect(counters.get("github__search_code")).toBe(1);
  });

  it("SDK-prefixed names with extra server prefix do NOT match unprefixed WRITE_TOOLS entries", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "mcp__praxis__memory_write",
      }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("operator-policy: realistic flow scenarios from production failure modes", () => {
  it("b51f2c47 shape: cap+1 search calls → cap allow + 1 deny with read-region hint", () => {
    const counters = newToolCounters();
    const classify = mkClassify({
      tier: "tier2",
      evidence_needed: ["github__*"],
    });
    let denied = 0;
    let allowed = 0;
    for (let i = 0; i < SEARCH_CAP + 1; i++) {
      const d = decideOperatorTool({
        classify,
        tool_name: "github__search_code",
        run_id: "b51f2c47",
        iter: i,
        counters,
      });
      if (d.allow) allowed += 1;
      else {
        denied += 1;
        expect(d.synthetic_tool_result).toMatch(/read_file/);
      }
    }
    expect(allowed).toBe(SEARCH_CAP);
    expect(denied).toBe(1);
  });

  it("worked example: tier3 with web_fetch + github evidence", () => {
    const counters = newToolCounters();
    const classify = mkClassify({
      tier: "tier3",
      evidence_needed: ["web_fetch__*", "github__*"],
      target_specialist: "engineer",
    });
    expect(
      decideOperatorTool({
        classify,
        tool_name: "web_fetch__fetch",
        run_id: "worked-ex",
        iter: 0,
        counters,
      }).allow,
    ).toBe(true);
    expect(
      decideOperatorTool({
        classify,
        tool_name: "github__read_file",
        run_id: "worked-ex",
        iter: 0,
        counters,
      }).allow,
    ).toBe(true);
    expect(
      decideOperatorTool({
        classify,
        tool_name: "praxis__handoff",
        run_id: "worked-ex",
        iter: 0,
        counters,
      }).allow,
    ).toBe(true);
    expect(
      decideOperatorTool({
        classify,
        tool_name: "github__push_to_main",
        run_id: "worked-ex",
        iter: 0,
        counters,
      }).allow,
    ).toBe(false);
  });

  it("low-confidence guess at tier2 → write denied, can still read", () => {
    const counters = newToolCounters();
    const classify = mkClassify({ tier: "tier2", confidence: 0.3 });
    const writeDecision = decideOperatorTool({
      classify,
      tool_name: "memory__write",
      run_id: "low-conf",
      iter: 0,
      counters,
    });
    expect(writeDecision.allow).toBe(false);
    if (!writeDecision.allow)
      expect(writeDecision.reason).toBe("low_confidence_fail_closed");

    const readDecision = decideOperatorTool({
      classify,
      tool_name: "memory__search",
      run_id: "low-conf",
      iter: 0,
      counters,
    });
    expect(readDecision.allow).toBe(true);
  });
});

describe("operator-policy: synthetic body shape contracts", () => {
  it("budget-exhausted body cites the tool name and cap", () => {
    const counters = newToolCounters();
    counters.set("github__search_code", SEARCH_CAP);
    const d = decideOperatorTool(
      mkInput({ tool_name: "github__search_code", counters }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.synthetic_tool_result).toMatch(/github__search_code/);
      expect(d.synthetic_tool_result).toMatch(new RegExp(`cap: ${SEARCH_CAP}`));
    }
  });

  it("missing-classify body shows the example envelope shape", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: undefined,
        tool_name: "memory__write",
        iter: 0,
      }),
    );
    if (!d.allow) {
      expect(d.synthetic_tool_result).toMatch(/<plan>/);
      expect(d.synthetic_tool_result).toMatch(/"classify"/);
      expect(d.synthetic_tool_result).toMatch(/"tier"/);
    }
  });

  it("tier3 write-denied body suggests handoff", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3" }),
        tool_name: "memory__write",
      }),
    );
    if (!d.allow) {
      expect(d.synthetic_tool_result).toMatch(/praxis__handoff/);
    }
  });

  it("all denial bodies stay under the soft 2000-char cap", () => {
    const cases = [
      (() => {
        const counters = newToolCounters();
        counters.set("github__search_code", SEARCH_CAP);
        return decideOperatorTool(
          mkInput({ tool_name: "github__search_code", counters }),
        );
      })(),
      decideOperatorTool(
        mkInput({
          classify: undefined,
          tool_name: "memory__write",
          iter: 0,
        }),
      ),
      decideOperatorTool(
        mkInput({
          classify: mkClassify({ confidence: 0.1 }),
          tool_name: "memory__write",
        }),
      ),
      decideOperatorTool(
        mkInput({
          classify: mkClassify({ tier: "tier3" }),
          tool_name: "memory__write",
        }),
      ),
      decideOperatorTool(
        mkInput({
          classify: mkClassify({ tier: "tier3", evidence_needed: [] }),
          tool_name: "memory__search",
        }),
      ),
    ];
    for (const d of cases) {
      expect(d.allow).toBe(false);
      if (!d.allow) {
        expect(d.synthetic_tool_result.length).toBeLessThan(2000);
        expect(d.synthetic_tool_result.length).toBeGreaterThan(50);
      }
    }
  });
});

describe("operator-policy: external-write commit-verb intent classifier (pure)", () => {
  it('"file a SCRUM ticket titled X with body Y" → commit', () => {
    expect(
      classifyExternalWriteIntent("file a SCRUM ticket titled X with body Y"),
    ).toBe("commit");
  });

  it('"draft up a Jira ticket to investigate slow payouts" → hold', () => {
    expect(
      classifyExternalWriteIntent(
        "draft up a Jira ticket to investigate slow payouts",
      ),
    ).toBe("hold");
  });

  it('"ok file it" → commit', () => {
    expect(classifyExternalWriteIntent("ok file it")).toBe("commit");
  });

  it('"don\'t file anything yet" → hold', () => {
    expect(classifyExternalWriteIntent("don't file anything yet")).toBe("hold");
  });

  it("negative/non-final intent WINS when BOTH a commit verb and a hold appear", () => {
    expect(
      classifyExternalWriteIntent(
        "file the ticket but actually don't post it yet",
      ),
    ).toBe("hold");
  });

  it("explicit confirmation as the LATEST clause overrides an earlier hold", () => {
    expect(
      classifyExternalWriteIntent(
        "earlier I said don't file yet, but go ahead and file it now",
      ),
    ).toBe("commit");
  });

  it("a bare ask with no commit verb and no hold → unknown (does not over-block, does not auto-greenlight)", () => {
    expect(
      classifyExternalWriteIntent("there is a recurring complaint about payouts"),
    ).toBe("unknown");
  });

  it('"look into slow payouts" (investigate-flavored) → hold (safety-additive: do not auto-file)', () => {
    expect(classifyExternalWriteIntent("look into slow payouts")).toBe("hold");
  });

  it("normal one-shot 'file a ticket titled X' is NOT over-blocked", () => {
    expect(classifyExternalWriteIntent("file a ticket titled Outage P1")).toBe(
      "commit",
    );
  });
});

describe("operator-policy: praxis__action external-write gate (draft → confirm)", () => {
  it('"file a SCRUM ticket titled X with body Y" → praxis__action ALLOWED', () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
        latest_user_text: "file a SCRUM ticket titled X with body Y",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it('"draft up a Jira ticket to investigate slow payouts" → praxis__action BLOCKED (returns draft)', () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
        latest_user_text:
          "There's a recurring complaint about slow host payouts. Draft up a Jira ticket for the engineering team to investigate it.",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toBe("external_write_needs_commit_intent");
      expect(d.synthetic_tool_result).toMatch(/DRAFT/i);
      expect(d.synthetic_tool_result).toMatch(/confirm/i);
    }
  });

  it("turn1 draft (BLOCKED) then turn2 'ok file it' (ALLOWED on turn2)", () => {
    const counters = newToolCounters();
    const t1 = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
        latest_user_text: "draft up a Jira ticket to investigate slow payouts",
        counters,
        iter: 0,
      }),
    );
    expect(t1.allow).toBe(false);
    if (!t1.allow) expect(t1.reason).toBe("external_write_needs_commit_intent");
    expect(counters.get("praxis__action")).toBeUndefined();

    const t2 = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
        latest_user_text: "ok file it",
        counters,
        iter: 0,
      }),
    );
    expect(t2.allow).toBe(true);
  });

  it("turn1 'file it' (ALLOWED, the action fires) then turn2 'don't file yet' (gate cannot undo a prior fire)", () => {
    const counters = newToolCounters();
    const t1 = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
        latest_user_text: "file it",
        counters,
        iter: 0,
      }),
    );
    expect(t1.allow).toBe(true);
    expect(counters.get("praxis__action")).toBe(1);

    const t2 = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
        latest_user_text: "actually hold on — don't file anything yet",
        counters,
        iter: 0,
      }),
    );
    expect(t2.allow).toBe(false);
    if (!t2.allow) expect(t2.reason).toBe("external_write_needs_commit_intent");
    expect(counters.get("praxis__action")).toBe(1);
  });

  it("missing latest_user_text → gate is INERT (behavior unchanged, praxis__action allowed)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "praxis__action",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("gate only applies to external-write praxis__action — memory__write is unaffected", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "memory__write",
        latest_user_text: "draft up a Jira ticket to investigate slow payouts",
      }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("decideOperatorTool — AgentMail D2 egress kill on untrusted inbound", () => {
  it("DENIES web_fetch on an email-triggered (untrusted_inbound) run", () => {
    const d = decideOperatorTool({
      classify: { tier: "tier1", confidence: 0.9, evidence_needed: ["web_fetch__*"], target_specialist: undefined },
      tool_name: "web_fetch__fetch",
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("DENIES web_search even when declared in evidence_needed (untrusted inbound overrides)", () => {
    const d = decideOperatorTool({
      classify: { tier: "tier3", confidence: 0.9, evidence_needed: ["web_search__*"], target_specialist: "engineer" },
      tool_name: "web_search__search",
      run_id: "r",
      iter: 1,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("ALLOWS web_fetch on a normal (chat) run — flag absent, behavior unchanged", () => {
    const d = decideOperatorTool({
      classify: { tier: "tier1", confidence: 0.9, evidence_needed: ["web_fetch__*"], target_specialist: undefined },
      tool_name: "web_fetch__fetch",
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
    });
    expect(d.allow).toBe(true);
  });

  it("ALLOWS operator_db reads on an email run (only egress is killed, not all tools)", () => {
    const d = decideOperatorTool({
      classify: { tier: "tier1", confidence: 0.9, evidence_needed: [], target_specialist: undefined },
      tool_name: "operator_db__query_user",
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(true);
  });

  it("ALLOWS handoff on an email run (delegation still works)", () => {
    const d = decideOperatorTool({
      classify: { tier: "tier3", confidence: 0.9, evidence_needed: [], target_specialist: "dispute-response" },
      tool_name: "praxis__handoff",
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(true);
  });

  const AGG_FETCH = "pipedream_apollo__fetch";
  const prevMode = process.env.CAPABILITY_FAILCLOSED_MODE;
  afterEach(() => {
    if (prevMode === undefined) delete process.env.CAPABILITY_FAILCLOSED_MODE;
    else process.env.CAPABILITY_FAILCLOSED_MODE = prevMode;
  });

  it("DENIES a dynamic aggregator fetch tool on an email run (enforce mode, #7)", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    const d = decideOperatorTool({
      classify: { tier: "tier1", confidence: 0.9, evidence_needed: [], target_specialist: undefined },
      tool_name: AGG_FETCH,
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("egress_denied_untrusted_inbound");
  });

  it("SHADOW mode ALLOWS the aggregator (observe-only rollout, #7)", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "shadow";
    const d = decideOperatorTool({
      classify: { tier: "tier1", confidence: 0.9, evidence_needed: [], target_specialist: undefined },
      tool_name: AGG_FETCH,
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(true);
  });

  it("STILL denies apify__rag_web_browser on an email run even in shadow (proven reader, #7)", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "shadow";
    const d = decideOperatorTool({
      classify: { tier: "tier1", confidence: 0.9, evidence_needed: [], target_specialist: undefined },
      tool_name: "apify__rag_web_browser",
      run_id: "r",
      iter: 0,
      counters: newToolCounters(),
      untrusted_inbound: true,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("egress_denied_untrusted_inbound");
  });
});

describe("operator-policy: derived remote-write classification (E3 #9)", () => {
  const COMPOSIO_WRITE = "composio__GMAIL_SEND_EMAIL";

  it("enforce (default): a composio wildcard write is TIER-3 DENIED like a static write", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3", target_specialist: "support-lead" }),
        tool_name: COMPOSIO_WRITE,
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("tier3_write_denied");
  });

  it("enforce: a composio write hits the commit-verb gate on a 'draft' ask", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: COMPOSIO_WRITE,
        latest_user_text: "draft up a message to the customer",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("external_write_needs_commit_intent");
  });

  it("enforce: missing classify on iter 0 fails closed for a composio write", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: undefined,
        iter: 0,
        tool_name: "composio__NOTION_UPDATE_PAGE",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("missing_classify_fail_closed");
  });

  it("shadow: the SAME composio write executes as today (allowed) + logs would_block", () => {
    const seen: Array<{ server_id: string; tool_name: string; gate: string }> = [];
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: COMPOSIO_WRITE,
        latest_user_text: "draft up a message to the customer",
        failclosed_mode: "shadow",
        on_would_block: (i) => seen.push(i),
      }),
    );
    expect(d.allow).toBe(true);
    expect(seen).toContainEqual({
      server_id: "composio",
      tool_name: "GMAIL_SEND_EMAIL",
      gate: "operator_external_write",
    });
  });

  it("per-tenant bypass: the composio write is unblocked even under enforce mode", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3", target_specialist: "support-lead" }),
        tool_name: COMPOSIO_WRITE,
        failclosed_mode: "enforce",
        failclosed_bypassed: true,
      }),
    );
    if (!d.allow) expect(d.reason).not.toBe("tier3_write_denied");
  });

  it("a first-party read (memory__search) is never write-classified", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier2" }),
        tool_name: "memory__search",
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("static first-party writes stay gated in EVERY mode (mode governs only derived writes)", () => {
    const d = decideOperatorTool(
      mkInput({
        classify: mkClassify({ tier: "tier3" }),
        tool_name: "github__open_pr",
        failclosed_mode: "shadow",
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("tier3_write_denied");
  });
});

describe("mention gate", () => {
  it("is inert when no mention was pinned (every ordinary turn)", () => {
    for (const tool of ["memory__search", "github__list_open_prs", "praxis__action"]) {
      const d = decideOperatorTool(mkInput({ tool_name: tool, mention_target: null }));
      if (!d.allow) expect(d.reason).not.toBe("mention_requires_handoff");
    }
  });

  it("denies every non-handoff tool on an addressed turn", () => {
    for (const tool of [
      "memory__search",
      "operator_db__catalog",
      "github__read_file",
      "praxis__action",
      "web_fetch__fetch",
    ]) {
      const d = decideOperatorTool(
        mkInput({ tool_name: tool, mention_target: "meta_ads" }),
      );
      expect(d.allow, `${tool} should be denied`).toBe(false);
      if (!d.allow) {
        expect(d.reason).toBe("mention_requires_handoff");
        expect(d.synthetic_tool_result).toContain("meta_ads");
      }
    }
  });

  it("lets the handoff through on an addressed turn", () => {
    const d = decideOperatorTool(
      mkInput({
        tool_name: "praxis__handoff",
        mention_target: "meta_ads",
        classify: mkClassify({ tier: "tier3", target_specialist: "meta_ads" }),
      }),
    );
    expect(d.allow).toBe(true);
  });

  it("denies ask_agent and handoff_parallel on an addressed turn", () => {
    for (const tool of ["praxis__ask_agent", "praxis__handoff_parallel"]) {
      const d = decideOperatorTool(
        mkInput({
          tool_name: tool,
          mention_target: "cgo",
          classify: mkClassify({ tier: "tier3", target_specialist: "cgo" }),
        }),
      );
      expect(d.allow, `${tool} should be denied`).toBe(false);
      if (!d.allow) {
        expect(d.reason).toBe("mention_requires_handoff");
        expect(d.synthetic_tool_result).toContain("praxis__handoff(");
      }
    }
  });

  it("lets the pinned handoff through even when the turn was classified tier1", () => {
    const d = decideOperatorTool(
      mkInput({
        tool_name: "praxis__handoff",
        mention_target: "cgo",
        classify: mkClassify({ tier: "tier1", confidence: 0.95 }),
      }),
    );
    expect(d.allow).toBe(true);
    const plain = decideOperatorTool(
      mkInput({ tool_name: "praxis__handoff", classify: mkClassify({ tier: "tier1", confidence: 0.95 }) }),
    );
    expect(plain.allow).toBe(false);
    if (!plain.allow) expect(plain.reason).toBe("tier1_lookup_handoff_denied");
  });

  it("denies a read on an addressed turn even when the tier would allow it", () => {
    const d = decideOperatorTool(
      mkInput({
        tool_name: "memory__search",
        mention_target: "meta_ads",
        classify: mkClassify({ tier: "tier1", confidence: 0.95 }),
      }),
    );
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("mention_requires_handoff");
  });
});
