
import { describe, it, expect } from "vitest";
import { BEHAVIOR_GOLDENS } from "../behavior-goldens";
import { scoreBehavior } from "../behavior-runner";

describe("behavior goldens — deterministic ask-before-money-move + envelope-shape gate (no LLM)", () => {
  const report = scoreBehavior(BEHAVIOR_GOLDENS);

  it("every behavior golden decides as expected (100% deterministic accuracy)", () => {
    const failures = report.cases
      .filter((c) => !c.pass)
      .map((c) => `  ✗ [${c.kind}] ${c.name}: ${c.reason}`)
      .join("\n");
    expect(failures, `behavior golden failures:\n${failures}`).toBe("");
    expect(report.accuracy).toBe(1);
    expect(report.passed).toBe(report.total);
  });

  it("no seeded behavior incident regressed", () => {
    expect(
      report.incidentFailures.map((c) => `${c.name}: ${c.reason}`).join("\n"),
    ).toBe("");
  });

  it("both behaviors + every seeded incident are actually present", () => {
    const kinds = new Set(BEHAVIOR_GOLDENS.map((g) => g.kind));
    expect(kinds.has("money_move")).toBe(true);
    expect(kinds.has("envelope")).toBe(true);

    const incidents = new Set(
      BEHAVIOR_GOLDENS.map((g) => g.incident).filter(Boolean),
    );
    expect(incidents.has("money_move_auto_fire")).toBe(true);
    expect(incidents.has("meta_placeholder_double_render")).toBe(true);
    expect(incidents.has("blank_render_seam")).toBe(true);
    expect(incidents.has("machine_json_leak")).toBe(true);
  });

  it("INVARIANT: no money-moving / irreversible-write action ever resolves to AUTO", () => {
    const autoFireable = BEHAVIOR_GOLDENS.filter(
      (g) =>
        g.kind === "money_move" &&
        g.money_or_write &&
        g.expect.autonomy === "auto",
    );
    expect(
      autoFireable.map((g) => g.name).join("\n"),
      "a money/write golden asserts auto-fire — that is the exact regression this gate must forbid",
    ).toBe("");
  });

  it("the money-move gate does NOT wall legitimate non-money paths (teammate messaging + reads)", () => {
    const money = BEHAVIOR_GOLDENS.filter(
      (g): g is Extract<typeof g, { kind: "money_move" }> => g.kind === "money_move",
    );
    const slack = money.find((g) => g.name.includes("slack post_message"));
    const read = money.find((g) => g.name.includes("stripe list_charges"));
    expect(slack?.expect.autonomy).toBe("auto");
    expect(read?.expect.autonomy).toBe("ungoverned");
  });
});
