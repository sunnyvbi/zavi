import { describe, it, expect, vi } from "vitest";

import {
  detectNegativeExistenceClaims,
  groundNegativeExistence,
  detectConnectorAbsenceClaims,
  verifyConnectorAbsence,
  type GroundingGithubDeps,
} from "../negative-existence-grounding-verifier";

const ANDROID_HALT =
  "I investigated the repo to build host-reply-to-review. I could not locate a " +
  "host-review reply endpoint in the backend. There is also no `response` field " +
  "on the Rating model. Without those, this feature cannot be implemented.";

const CARS_ROUTE_BODY = [
  "import { Router } from 'express';",
  "const router = Router();",
  "// ...",
  "router.post('/respondToCarReview', carsController.respondToCarReview);",
  "export default router;",
].join("\n");

const RATING_MODEL_BODY = [
  "export const Rating = sequelize.define('Rating', {",
  "  stars: { type: DataTypes.INTEGER },",
  "  response: { type: DataTypes.TEXT, allowNull: true },",
  "});",
].join("\n");

function stubDeps(over: Partial<GroundingGithubDeps> = {}): GroundingGithubDeps {
  return {
    listConnectedRepos: async () => ["rravi149/upcar"],
    resolveInstallationId: async () => 1234,
    assertReadRepoMembership: async () => undefined,
    searchCode: (async (_t: string, _i: number, args: { query: string }) => {
      if (args.query === "respondToCarReview") {
        return { total: 1, items: [{ name: "cars.route.ts", path: "src/routes/cars.route.ts", url: "" }] };
      }
      if (args.query === "response") {
        return {
          total: 1,
          items: [{ name: "car.rating.model.ts", path: "src/models/car.rating.model.ts", url: "" }],
        };
      }
      if (args.query === "review") {
        return { total: 1, items: [{ name: "cars.route.ts", path: "src/routes/cars.route.ts", url: "" }] };
      }
      return { total: 0, items: [] };
    }) as unknown as GroundingGithubDeps["searchCode"],
    readFile: (async (_t: string, _i: number, args: { path: string }) => {
      if (args.path.includes("cars.route")) return { content: CARS_ROUTE_BODY, truncated: false };
      if (args.path.includes("car.rating")) return { content: RATING_MODEL_BODY, truncated: false };
      return { content: "", truncated: false };
    }) as unknown as GroundingGithubDeps["readFile"],
    ...over,
  };
}

describe("detectNegativeExistenceClaims", () => {
  it("fires on the literal Android halt text (endpoint + field claims)", () => {
    const claims = detectNegativeExistenceClaims(ANDROID_HALT);
    const symbols = claims.map((c) => c.symbol.toLowerCase());
    const kinds = claims.map((c) => c.kind);
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(kinds).toContain("endpoint");
    expect(symbols.join(" ")).toMatch(/response|host-review|host/);
  });

  it("does NOT match operational negatives (no code context)", () => {
    expect(
      detectNegativeExistenceClaims("The GitHub connector is not connected for this tenant."),
    ).toEqual([]);
    expect(
      detectNegativeExistenceClaims("No rows were returned from the query."),
    ).toEqual([]);
    expect(
      detectNegativeExistenceClaims("I could not find any recent ad spend in the account."),
    ).toEqual([]);
  });

  it("returns [] on empty / non-string input", () => {
    expect(detectNegativeExistenceClaims("")).toEqual([]);
    // @ts-expect-error — exercising the runtime guard.
    expect(detectNegativeExistenceClaims(null)).toEqual([]);
  });
});

describe("groundNegativeExistence", () => {
  it("returns FALSE-positive-refuting evidence when the claimed-absent endpoint EXISTS", async () => {
    const claims = [
      { claim: "could not locate a host-review reply endpoint", symbol: "respondToCarReview", kind: "endpoint" as const },
    ];
    const out = await groundNegativeExistence("t-1", claims, stubDeps());
    expect(out).toHaveLength(1);
    expect(out[0].exists).toBe(true);
    expect(out[0].evidence).toBeTruthy();
    expect(out[0].evidence?.matched_symbol).toBe("respondToCarReview");
    expect(out[0].evidence?.path).toContain("cars.route");
    expect(out[0].evidence?.hit_type).toBe("route");
    expect(out[0].evidence?.line).toBeGreaterThan(0);
  });

  it("confirms an EXISTING model field (the `response` field on Rating)", async () => {
    const claims = [
      { claim: "no response field on the Rating model", symbol: "response", kind: "field" as const },
    ];
    const out = await groundNegativeExistence("t-1", claims, stubDeps());
    expect(out[0].exists).toBe(true);
    expect(out[0].evidence?.hit_type).toBe("field");
    expect(out[0].evidence?.path).toContain("car.rating");
  });

  it("connector-absent tenant → unverifiable + ZERO github call", async () => {
    const searchSpy = vi.fn();
    const out = await groundNegativeExistence(
      "t-no-connector",
      [{ claim: "no foo endpoint", symbol: "fooHandler", kind: "endpoint" as const }],
      stubDeps({
        listConnectedRepos: async () => [],
        searchCode: searchSpy as never,
        readFile: searchSpy as never,
      }),
    );
    expect(out[0].exists).toBeUndefined();
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("search miss → exists:false (a TRUE refusal is never penalized)", async () => {
    const out = await groundNegativeExistence(
      "t-1",
      [{ claim: "no bar endpoint", symbol: "barThatDoesNotExist", kind: "endpoint" as const }],
      stubDeps(),
    );
    expect(out[0].exists).toBe(false);
    expect(out[0].evidence).toBeUndefined();
  });

  it("SEMANTIC: wrong-name endpoint (`replyToReview`) clamps because `respondToCarReview` satisfies the same {respond, review} signature", async () => {
    const claims = [
      {
        claim: "I could not locate a reply-to-review endpoint; there is no replyToReview route.",
        symbol: "replyToReview",
        kind: "endpoint" as const,
      },
    ];
    const out = await groundNegativeExistence("t-1", claims, stubDeps());
    expect(out[0].exists).toBe(true);
    expect(out[0].evidence?.match_mode).toBe("semantic");
    expect(out[0].evidence?.matched_symbol).toBe("respondToCarReview");
    expect(out[0].evidence?.action_match).toBe("respond");
    expect(out[0].evidence?.object_match).toBe("review");
    expect(out[0].evidence?.path).toContain("cars.route");
  });

  it("SEMANTIC: matches a NAMED router (`reviewsRouter.post('/respondToCarReview')`)", async () => {
    const NAMED_ROUTER_BODY = [
      "const reviewsRouter = Router();",
      "reviewsRouter.post('/respondToCarReview', carsController.respondToCarReview);",
      "export default reviewsRouter;",
    ].join("\n");
    const out = await groundNegativeExistence(
      "t-1",
      [{ claim: "no replyToReview route exists", symbol: "replyToReview", kind: "endpoint" as const }],
      stubDeps({
        readFile: (async () => ({ content: NAMED_ROUTER_BODY, truncated: false })) as unknown as GroundingGithubDeps["readFile"],
      }),
    );
    expect(out[0].exists).toBe(true);
    expect(out[0].evidence?.match_mode).toBe("semantic");
    expect(out[0].evidence?.matched_symbol).toBe("respondToCarReview");
  });

  it("SEMANTIC GUARD: a missing DELETE-review endpoint is NOT clamped by the existing RESPOND-review route", async () => {
    const claims = [
      {
        claim: "Could not locate a delete-review-reply endpoint; there is no deleteReviewReply route.",
        symbol: "deleteReviewReply",
        kind: "endpoint" as const,
      },
    ];
    const out = await groundNegativeExistence("t-1", claims, stubDeps());
    expect(out[0].exists).toBe(false);
    expect(out[0].evidence).toBeUndefined();
  });

  it("FIELD GUARD: `response` field on Rating does NOT confirm a claim about the HostReview model", async () => {
    const claims = [
      { claim: "There is no `response` field on the HostReview model.", symbol: "response", kind: "field" as const },
    ];
    const out = await groundNegativeExistence("t-1", claims, stubDeps());
    expect(out[0].exists).toBe(false);
  });

  it("soft hit (symbol present but no confirmatory shape) → exists:false (no clamp)", async () => {
    const out = await groundNegativeExistence(
      "t-1",
      [{ claim: "no respondToCarReview endpoint", symbol: "respondToCarReview", kind: "endpoint" as const }],
      stubDeps({
        readFile: (async () => ({
          content: "// respondToCarReview is a TODO, not built yet",
          truncated: false,
        })) as unknown as GroundingGithubDeps["readFile"],
      }),
    );
    expect(out[0].exists).toBe(false);
  });
});

describe("connector-absence (operational-negative) lane", () => {
  it("detects '<connector> not connected' phrasings; ignores code-symbol negatives", () => {
    expect(
      detectConnectorAbsenceClaims("Slack is not connected to your workspace.").map(
        (c) => c.connector,
      ),
    ).toEqual(["slack"]);
    expect(
      detectConnectorAbsenceClaims("You have no GitHub connection yet.").map(
        (c) => c.connector,
      ),
    ).toEqual(["github"]);
    expect(
      detectConnectorAbsenceClaims("The respondToReview endpoint does not exist."),
    ).toEqual([]);
  });

  it("hedges when a claimed-absent connector IS actually connected (negative is false)", async () => {
    const res = await verifyConnectorAbsence({
      tenant_id: "t1",
      reply: "I can't pull that — Slack is not connected to your workspace.",
      deps: { listConnected: async () => [{ slug: "slack" }, { slug: "github" }] },
    });
    expect(res.hedged).toBe(true);
    expect(res.flags.connectors_falsely_claimed_absent).toEqual(["slack"]);
    expect(res.text).toMatch(/Correction/);
    expect(res.text).toMatch(/Slack is actually connected/);
    expect(res.text).toMatch(/I can't pull that/);
  });

  it("does NOT hedge when the connector really is absent (the negative stands)", async () => {
    const res = await verifyConnectorAbsence({
      tenant_id: "t1",
      reply: "GitHub is not connected, so I can't read the repo.",
      deps: { listConnected: async () => [{ slug: "slack" }] },
    });
    expect(res.hedged).toBe(false);
    expect(res.flags.has_connector_absence_claim).toBe(true);
    expect(res.flags.connectors_falsely_claimed_absent).toEqual([]);
  });

  it("does NOT mask a real *_not_connected tool error (evidence gate)", async () => {
    const res = await verifyConnectorAbsence({
      tenant_id: "t1",
      reply: "Slack is not connected right now.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCalls: [
        {
          name: "slack__post_message",
          input_preview: "",
          output_preview: '{"error":"slack_not_connected"}',
          ms: 1,
          status: "tool_error",
        },
      ] as any,
      deps: { listConnected: async () => [{ slug: "slack" }] },
    });
    expect(res.hedged).toBe(false);
    expect(res.flags.grounded_by_tool_error).toBe(true);
  });

  it("no connector-absence claim → immediate pass with ZERO connector read", async () => {
    let called = false;
    const res = await verifyConnectorAbsence({
      tenant_id: "t1",
      reply: "Your Slack is connected and healthy — 3 workspaces.",
      deps: {
        listConnected: async () => {
          called = true;
          return [];
        },
      },
    });
    expect(res.hedged).toBe(false);
    expect(called).toBe(false);
  });

  it("fails open when the connector read throws", async () => {
    const res = await verifyConnectorAbsence({
      tenant_id: "t1",
      reply: "Slack is not connected.",
      deps: {
        listConnected: async () => {
          throw new Error("db down");
        },
      },
    });
    expect(res.hedged).toBe(false);
  });
});
