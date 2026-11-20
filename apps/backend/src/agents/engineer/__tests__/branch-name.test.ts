import { describe, it, expect } from "vitest";
import { slugifyTask, buildEngineerBranch, resolveHeadBranch } from "../branch-name";

const RUN_ID = "a1ef6b99-4c2d-4f1a-9b3e-77c0d8e2f001";

describe("slugifyTask", () => {
  it("turns a task sentence into a readable kebab slug", () => {
    expect(slugifyTask("Fix the Android login crash")).toBe(
      "fix-android-login-crash",
    );
  });

  it("strips asking-noise from the front only", () => {
    expect(slugifyTask("Can you please add to cart button")).toBe(
      "add-to-cart-button",
    );
  });

  it("preserves issue keys so the branch points back at the tracker", () => {
    expect(slugifyTask("DEL-806 zavi feedback changes")).toBe(
      "del-806-zavi-feedback-changes",
    );
  });

  it("drops pasted code fences and URLs instead of slugging symbol soup", () => {
    const slug = slugifyTask(
      "Fix crash ```TypeError: undefined is not a function``` see https://ex.com/a/b",
    );
    expect(slug).toBe("fix-crash-see");
  });

  it("clamps to the charset that makes every git-ref rule unreachable", () => {
    const slug = slugifyTask("Fix @{weird}.. ~naming^ /issue/ .lock");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("-")).toBe(false);
    expect(slug).not.toContain("..");
  });

  it("cuts long tasks at a word boundary, never mid-word", () => {
    const slug = slugifyTask(
      "Refactor the entire authentication middleware pipeline to support tenant scoped tokens",
    );
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    for (const word of slug.split("-")) {
      expect(
        "refactor entire authentication middleware pipeline to support tenant scoped tokens".split(
          " ",
        ),
      ).toContain(word);
    }
  });

  it("drops apostrophes instead of letting them split a word", () => {
    expect(slugifyTask("Dark mode toggle doesn't persist")).toBe(
      "dark-mode-toggle-doesnt-persist",
    );
  });

  it("trims connectives the caps strand at the end", () => {
    expect(
      slugifyTask("fix the checkout flow — payment fails silently for INR cards"),
    ).toBe("fix-checkout-flow-payment-fails-silently");
    expect(
      slugifyTask("hey could you look into why slack approvals are not showing up"),
    ).toBe("look-into-why-slack-approvals");
  });

  it("keeps an interior connective — only the TAIL is trimmed", () => {
    expect(slugifyTask("add to cart button")).toBe("add-to-cart-button");
  });

  it("never trims away the whole slug", () => {
    expect(slugifyTask("on it")).toBe("on");
  });

  it("returns empty when the text is all noise, so callers can fall back", () => {
    expect(slugifyTask("can you please")).toBe("");
    expect(slugifyTask("   ")).toBe("");
    expect(slugifyTask("")).toBe("");
  });
});

describe("buildEngineerBranch", () => {
  it("produces a descriptive branch a dev can read at a glance", () => {
    expect(
      buildEngineerBranch(RUN_ID, ["Fix the Android login crash"]),
    ).toBe("engineer/fix-android-login-crash-a1ef6b99");
  });

  it("keeps the engineer/ prefix the PR-shepherd skip rule depends on", () => {
    expect(buildEngineerBranch(RUN_ID, ["anything"])).toMatch(/^engineer\//);
    expect(buildEngineerBranch(RUN_ID, [], "product-builder")).toMatch(
      /^product-builder\//,
    );
  });

  it("is DETERMINISTIC per run — the replay-idempotency precondition", () => {
    const a = buildEngineerBranch(RUN_ID, ["Fix the Android login crash"]);
    const b = buildEngineerBranch(RUN_ID, ["Fix the Android login crash"]);
    expect(a).toBe(b);
  });

  it("stays UNIQUE across runs that share a task description", () => {
    const a = buildEngineerBranch(RUN_ID, ["Fix the login crash"]);
    const b = buildEngineerBranch(
      "b2fa7c00-1111-4222-8333-444455556666",
      ["Fix the login crash"],
    );
    expect(a).not.toBe(b);
  });

  it("falls through sources in order, preferring the replay-stable one", () => {
    expect(
      buildEngineerBranch(RUN_ID, ["Fix login crash", "some model title"]),
    ).toBe("engineer/fix-login-crash-a1ef6b99");
    expect(buildEngineerBranch(RUN_ID, [undefined, "Some Model Title"])).toBe(
      "engineer/some-model-title-a1ef6b99",
    );
    expect(
      buildEngineerBranch(RUN_ID, ["can you please", "Real Title"]),
    ).toBe("engineer/real-title-a1ef6b99");
  });

  it("degrades to a still-unique branch when nothing slugs", () => {
    expect(buildEngineerBranch(RUN_ID, [undefined, null, ""])).toBe(
      "engineer/a1ef6b99",
    );
  });

  it("fits the 120-char schema cap with room for the multi-base suffix", () => {
    const branch = buildEngineerBranch(RUN_ID, [
      "Refactor the entire authentication middleware pipeline to support tenant scoped tokens everywhere",
    ]);
    expect(branch.length).toBeLessThanOrEqual(120 - 41);
    expect(branch).toMatch(/^[A-Za-z0-9._/-]+$/);
  });

  it("survives a malformed run id rather than emitting a bare prefix", () => {
    expect(buildEngineerBranch("", ["Fix login"])).toBe(
      "engineer/fix-login-run",
    );
  });
});

const baseInput = {
  agentSlug: "engineer",
  runId: RUN_ID,
  emitted: "engineer/whatever-the-model-chose",
  isProductBuildCodegen: false,
  followupCheckoutRef: "",
  slugSources: ["Fix the Android login crash"],
  priorBranch: null as string | null,
};

describe("resolveHeadBranch — engineer branches are server-authoritative", () => {
  it("replaces the model's chosen suffix with the task slug + run token", () => {
    expect(resolveHeadBranch(baseInput)).toBe(
      "engineer/fix-android-login-crash-a1ef6b99",
    );
  });

  it("stamps a branch when the model omitted head_branch entirely", () => {
    for (const emitted of [undefined, null, "", "   ", 42]) {
      expect(resolveHeadBranch({ ...baseInput, emitted })).toBe(
        "engineer/fix-android-login-crash-a1ef6b99",
      );
    }
  });

  it("substitutes a verbatim {run_id} template the model copied", () => {
    expect(
      resolveHeadBranch({ ...baseInput, emitted: "engineer/{run_id}" }),
    ).toBe("engineer/fix-android-login-crash-a1ef6b99");
  });

  it("leaves an un-substituted template on a NON-engineer branch for the caller to fail closed", () => {
    const out = resolveHeadBranch({
      ...baseInput,
      agentSlug: "engineer",
      emitted: "product-builder/{something_else}",
    });
    expect(out).toContain("{");
  });
});

describe("resolveHeadBranch — FOLLOW-UP runs (fail-closed at dispatch)", () => {
  const followup = {
    ...baseInput,
    followupCheckoutRef: "engineer/original-task-deadbeef",
  };

  it("returns the server-pinned checkout_ref, never a new branch", () => {
    expect(resolveHeadBranch(followup)).toBe("engineer/original-task-deadbeef");
  });

  it("corrects a model that emitted the WRONG branch on a follow-up", () => {
    expect(
      resolveHeadBranch({ ...followup, emitted: "engineer/some-other-branch" }),
    ).toBe("engineer/original-task-deadbeef");
  });

  it("restores the ref when the model omitted head_branch on a follow-up", () => {
    expect(resolveHeadBranch({ ...followup, emitted: undefined })).toBe(
      "engineer/original-task-deadbeef",
    );
  });

  it("outranks a prior branch — the open PR's ref is the only valid target", () => {
    expect(
      resolveHeadBranch({ ...followup, priorBranch: "engineer/stale-aaaaaaaa" }),
    ).toBe("engineer/original-task-deadbeef");
  });
});

describe("resolveHeadBranch — replay idempotency", () => {
  it("reuses the branch this run already pushed", () => {
    expect(
      resolveHeadBranch({
        ...baseInput,
        slugSources: ["A Reworded Title On The Re-Fire"],
        priorBranch: "engineer/fix-android-login-crash-a1ef6b99",
      }),
    ).toBe("engineer/fix-android-login-crash-a1ef6b99");
  });

  it("recomputes deterministically when there is no prior branch", () => {
    const a = resolveHeadBranch(baseInput);
    const b = resolveHeadBranch({ ...baseInput });
    expect(a).toBe(b);
  });
});

describe("resolveHeadBranch — non-engineer paths stay untouched", () => {
  it("product-builder codegen keeps its runId branch", () => {
    expect(
      resolveHeadBranch({
        ...baseInput,
        emitted: undefined,
        isProductBuildCodegen: true,
      }),
    ).toBe(`product-builder/${RUN_ID}`);
  });

  it("an operator-instructed non-engineer branch passes through verbatim", () => {
    expect(
      resolveHeadBranch({ ...baseInput, emitted: "product-builder/content-x-123" }),
    ).toBe("product-builder/content-x-123");
  });

  it("another agent's blank branch is left for its own path to stamp", () => {
    expect(
      resolveHeadBranch({ ...baseInput, agentSlug: "pm", emitted: undefined }),
    ).toBeUndefined();
  });
});
