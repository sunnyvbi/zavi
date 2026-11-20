import { describe, it, expect } from "vitest";
import {
  classifyToolRisk,
  isWriteClass,
  isE3WriteClass,
  type ToolRiskClass,
} from "../tool-risk-registry";
import { INTERNAL_SERVERS, isSideEffectingTool } from "../tool-effect-classifier";
import { isMeteredWriteTool } from "../higgsfield-meter";
import { effectOf, internalToolEffects } from "../tool-effects";

const ALL_CLASSES: ToolRiskClass[] = [
  "read",
  "write_low",
  "write_external",
  "write_code",
  "write_money",
];

describe("classifyToolRisk — totality", () => {
  it("returns exactly one valid class for every probed tool", () => {
    const servers = [...INTERNAL_SERVERS, "higgsfield", "composio", "pipedream_x"];
    for (const s of servers) {
      for (const t of ["get_thing", "create_thing", "post_message", "generate_video"]) {
        const cls = classifyToolRisk(s, t);
        expect(ALL_CLASSES).toContain(cls);
      }
    }
  });
});

describe("classifyToolRisk — money is highest-rigor", () => {
  it("classifies Stripe + ad-platform writes as write_money", () => {
    expect(classifyToolRisk("stripe", "create_refund")).toBe("write_money");
    expect(classifyToolRisk("stripe", "update_customer")).toBe("write_money");
    expect(classifyToolRisk("google_ads", "create_campaign")).toBe("write_money");
    expect(classifyToolRisk("meta_ads", "set_budget")).toBe("write_money");
    expect(classifyToolRisk("paid_acquisition", "create_ad_set")).toBe("write_money");
  });
  it("classifies metered Higgsfield generation as write_money", () => {
    expect(classifyToolRisk("higgsfield", "generate_video")).toBe("write_money");
    expect(classifyToolRisk("higgsfield", "generate_image")).toBe("write_money");
  });
  it("does NOT classify non-metered generate_audio as money", () => {
    expect(classifyToolRisk("higgsfield", "generate_audio")).not.toBe("write_money");
  });
});

describe("classifyToolRisk — code writes", () => {
  it("classifies github repo mutations as write_code", () => {
    expect(classifyToolRisk("github", "create_pull_request")).toBe("write_code");
    expect(classifyToolRisk("github", "merge_pull_request")).toBe("write_code");
    expect(classifyToolRisk("github", "push")).toBe("write_code");
  });
});

describe("classifyToolRisk — external egress", () => {
  it("classifies third-party posts/sends/tickets as write_external", () => {
    expect(classifyToolRisk("slack", "post_message")).toBe("write_external");
    expect(classifyToolRisk("slack", "open_dm")).toBe("write_external");
    expect(classifyToolRisk("email", "send")).toBe("write_external");
    expect(classifyToolRisk("jira", "create_issue")).toBe("write_external");
    expect(classifyToolRisk("linear", "create_issue")).toBe("write_external");
  });
});

describe("classifyToolRisk — sandbox + browser (createSdkMcpServer surfaces)", () => {
  it("classifies sandbox code-exec/mutation tools as write_code", () => {
    expect(classifyToolRisk("sandbox", "run_bash")).toBe("write_code");
    expect(classifyToolRisk("sandbox", "create")).toBe("write_code");
    expect(classifyToolRisk("sandbox", "str_replace")).toBe("write_code");
    expect(classifyToolRisk("sandbox", "app_verify")).toBe("write_code");
  });
  it("classifies sandbox observation tools as read", () => {
    expect(classifyToolRisk("sandbox", "view")).toBe("read");
    expect(classifyToolRisk("sandbox", "read_file")).toBe("read");
  });
  it("classifies browser action tools as write_external (login-bearing)", () => {
    expect(classifyToolRisk("browser", "browser_fill")).toBe("write_external");
    expect(classifyToolRisk("browser", "browser_nav")).toBe("write_external");
    expect(classifyToolRisk("browser", "browser_click")).toBe("write_external");
  });
  it("classifies browser observation tools as read", () => {
    expect(classifyToolRisk("browser", "browser_screenshot")).toBe("read");
    expect(classifyToolRisk("browser", "browser_text")).toBe("read");
  });
});

describe("classifyToolRisk — reads never mis-classify as writes", () => {
  it("classifies declared reads as read across surfaces", () => {
    expect(classifyToolRisk("stripe", "retrieve_dispute")).toBe("read");
    expect(classifyToolRisk("github", "grep")).toBe("read");
    expect(classifyToolRisk("slack", "get_channel_history")).toBe("read");
    expect(classifyToolRisk("google_ads", "campaign_diagnostics")).toBe("read");
    expect(classifyToolRisk("memory", "search")).toBe("read");
    expect(classifyToolRisk("web_search", "search")).toBe("read");
    expect(classifyToolRisk("web_fetch", "fetch")).toBe("read");
    expect(classifyToolRisk("meta_ads", "daily_series")).toBe("read");
    expect(classifyToolRisk("meta_ads", "recent_changes")).toBe("read");
    expect(classifyToolRisk("jira", "search")).toBe("read");
    expect(classifyToolRisk("google_analytics", "run_report")).toBe("read");
  });
  it("classifies remote read-shaped tools as read", () => {
    expect(classifyToolRisk("composio", "get_status")).toBe("read");
  });
});

describe("classifyToolRisk — fail-safe upward", () => {
  it("classifies an unknown INTERNAL write as write_low, never read", () => {
    const cls = classifyToolRisk("growth", "mutate_something");
    expect(cls).toBe("write_low");
    expect(isWriteClass(cls)).toBe(true);
  });
  it("classifies an unknown REMOTE write-verb tool as write_external, not read", () => {
    expect(classifyToolRisk("pipedream_acme", "send_invoice")).toBe("write_external");
  });
});

describe("classifyToolRisk — reconciliation with source-of-truth surfaces (drift guard)", () => {
  it("every higgsfield metered write classifies as write_money (single source)", () => {
    for (const t of ["generate_video", "generate_image"]) {
      expect(isMeteredWriteTool("higgsfield", t)).toBe(true);
      expect(classifyToolRisk("higgsfield", t)).toBe("write_money");
    }
    expect(isMeteredWriteTool("higgsfield", "generate_audio")).toBe(false);
    expect(classifyToolRisk("higgsfield", "generate_audio")).not.toBe("write_money");
  });
  it("read/write split equals the tool's declaration and the idempotency ledger", () => {
    const probes: Array<[string, string]> = [
      ["slack", "history"], ["stripe", "create_refund"], ["stripe", "get"],
      ["github", "create_pull_request"], ["operator_db", "update_record"],
    ];
    for (const key of internalToolEffects().keys()) {
      const i = key.indexOf("__");
      probes.push([key.slice(0, i), key.slice(i + 2)]);
    }
    for (const [srv, tool] of probes) {
      const isWrite = isWriteClass(classifyToolRisk(srv, tool));
      expect(isWrite, `${srv}__${tool}`).toBe(isSideEffectingTool(srv, tool));
      expect(isWrite, `${srv}__${tool}`).toBe(effectOf(srv, tool) !== "read");
    }
  });
  it("every tool declared `money` is write_money, and sits on a server the registry already calls money", () => {
    const money = [...internalToolEffects()].filter(([, e]) => e === "money").map(([k]) => k);
    expect(money.length).toBeGreaterThan(0);
    for (const key of money) {
      const i = key.indexOf("__");
      expect(classifyToolRisk(key.slice(0, i), key.slice(i + 2)), key).toBe("write_money");
    }
  });
});

describe("isWriteClass / isE3WriteClass helpers", () => {
  it("isWriteClass is false only for read", () => {
    expect(isWriteClass("read")).toBe(false);
    for (const c of ALL_CLASSES.filter((c) => c !== "read")) {
      expect(isWriteClass(c)).toBe(true);
    }
  });
  it("isE3WriteClass covers money/code/external, not read/low", () => {
    expect(isE3WriteClass("write_money")).toBe(true);
    expect(isE3WriteClass("write_code")).toBe(true);
    expect(isE3WriteClass("write_external")).toBe(true);
    expect(isE3WriteClass("write_low")).toBe(false);
    expect(isE3WriteClass("read")).toBe(false);
  });
});

describe("GEO paid answer checks", () => {
  it("treats starting as money while keeping the existing card and read classifications", () => {
    expect(classifyToolRisk("geo", "start_answer_check")).toBe("write_money");
    expect(classifyToolRisk("geo", "propose_pr")).toBe("write_low");
    expect(classifyToolRisk("growth", "geo_visibility")).toBe("read");
  });
});

it("the GEO and operator agents both declare the new start capability", async () => {
  const { loadGlobalAgentDefinition } = await import("@/services/agents/registry");
  for (const slug of ["geo", "operator"]) {
    expect(loadGlobalAgentDefinition(slug)?.metadata_praxis.tools).toContain("geo__start_answer_check");
  }
});
