
import { describe, it, expect } from "vitest";

import {
  detectNegativeExistenceClaims,
  groundNegativeExistence,
  isBackendSubsystemPath,
  type GroundingGithubDeps,
} from "../negative-existence-grounding-verifier";

describe("detectNegativeExistenceClaims — precision (L1)", () => {
  it("does NOT fire on the chief-of-staff affirmation ('schema confirms ... no ownership gate')", () => {
    const text =
      "The `users` schema confirms `paymentMethods` are stored on the document " +
      "with no ownership gate on that endpoint.";
    expect(detectNegativeExistenceClaims(text)).toEqual([]);
  });

  it("does NOT fire on 'no <security-concept> on endpoint' (no auth / no gate)", () => {
    expect(
      detectNegativeExistenceClaims(
        "There is no auth on the `respondToCarReview` endpoint.",
      ),
    ).toEqual([]);
    expect(
      detectNegativeExistenceClaims(
        "The route exists but has no rate limit on that endpoint.",
      ),
    ).toEqual([]);
  });

  it("STILL fires when 'no' governs the code symbol or an adjacent code-kind noun", () => {
    const a = detectNegativeExistenceClaims(
      "There is no respondToReview endpoint in the backend.",
    );
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a[0].symbol.toLowerCase()).toContain("respondtoreview");

    const b = detectNegativeExistenceClaims(
      "There is no `auditLog` field on the model.",
    );
    expect(b.length).toBeGreaterThanOrEqual(1);
    expect(b[0].symbol.toLowerCase()).toBe("auditlog");
  });

  it("STILL fires on 'X endpoint is not implemented' (codex P2 — not-implemented is a documented absence)", () => {
    const a = detectNegativeExistenceClaims("The respondToReview endpoint is not implemented.");
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a[0].symbol.toLowerCase()).toContain("respondtoreview");
  });

  it("STILL fires on 'X endpoint does not exist' / 'could not find the X route'", () => {
    expect(
      detectNegativeExistenceClaims("The respondToReview endpoint does not exist.").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      detectNegativeExistenceClaims("I could not find the respondToReview route.").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("runs backtick-extracted candidates through the stopword filter (generic nouns rejected)", () => {
    expect(
      detectNegativeExistenceClaims("There is no `users` data on that endpoint."),
    ).toEqual([]);
    expect(
      detectNegativeExistenceClaims("The `config` field is missing on the endpoint."),
    ).toEqual([]);
  });

  it("affirmative-subject veto: a symbol governed by confirms/exists/stored/returns is NOT a claim", () => {
    expect(
      detectNegativeExistenceClaims(
        "The `respondToCarReview` endpoint confirms the capability exists.",
      ),
    ).toEqual([]);
    expect(
      detectNegativeExistenceClaims(
        "The `paymentMethods` field is stored on the user model.",
      ),
    ).toEqual([]);
    expect(
      detectNegativeExistenceClaims(
        "The endpoint returns `respondToCarReview` results from the model.",
      ),
    ).toEqual([]);
  });

  it("does NOT regress the operational-negative rejection", () => {
    expect(
      detectNegativeExistenceClaims("The GitHub connector is not connected for this tenant."),
    ).toEqual([]);
    expect(detectNegativeExistenceClaims("No rows were returned from the query.")).toEqual([]);
  });
});

describe("isBackendSubsystemPath", () => {
  it("accepts backend/server source paths", () => {
    expect(isBackendSubsystemPath("src/routes/cars.route.ts")).toBe(true);
    expect(isBackendSubsystemPath("apps/backend/src/models/car.rating.model.ts")).toBe(true);
    expect(isBackendSubsystemPath("server/controllers/reviews.js")).toBe(true);
  });

  it("rejects frontend/mobile file extensions", () => {
    expect(isBackendSubsystemPath("ContentView.swift")).toBe(false);
    expect(isBackendSubsystemPath("app/MainActivity.kt")).toBe(false);
    expect(isBackendSubsystemPath("apps/web/src/components/Card.tsx")).toBe(false);
    expect(isBackendSubsystemPath("src/views/Home.jsx")).toBe(false);
  });

  it("rejects mobile / frontend / test / fixture directories", () => {
    expect(isBackendSubsystemPath("ios/Sources/Foo.m")).toBe(false);
    expect(isBackendSubsystemPath("android/app/src/Foo.java")).toBe(false);
    expect(isBackendSubsystemPath("apps/mobile/screens/Chat.ts")).toBe(false);
    expect(isBackendSubsystemPath("src/__tests__/foo.test.ts")).toBe(false);
    expect(isBackendSubsystemPath("test/fixtures/sample.ts")).toBe(false);
  });
});

const RATING_MODEL_BODY = [
  "export const Rating = sequelize.define('Rating', {",
  "  stars: { type: DataTypes.INTEGER },",
  "  response: { type: DataTypes.TEXT, allowNull: true },",
  "});",
].join("\n");

function depsHittingPath(path: string, body: string): GroundingGithubDeps {
  return {
    listConnectedRepos: async () => ["rravi149/upcar"],
    resolveInstallationId: async () => 1234,
    assertReadRepoMembership: async () => undefined,
    searchCode: (async () => ({
      total: 1,
      items: [{ name: path.split("/").pop(), path, url: "" }],
    })) as unknown as GroundingGithubDeps["searchCode"],
    readFile: (async () => ({ content: body, truncated: false })) as unknown as GroundingGithubDeps["readFile"],
  };
}

describe("groundNegativeExistence — subsystem gate (L2)", () => {
  it("a model/field claim confirmed ONLY in a .swift file is NOT proof (annotate-only refused)", async () => {
    const out = await groundNegativeExistence(
      "t-1",
      [{ claim: "no users schema on the model", symbol: "users", kind: "model" as const }],
      depsHittingPath("ContentView.swift", "struct users { var paymentMethods: [String] }"),
    );
    expect(out[0].exists).toBe(false);
  });

  it("a field claim confirmed in a BACKEND model file still proves existence", async () => {
    const out = await groundNegativeExistence(
      "t-1",
      [{ claim: "no response field on the Rating model", symbol: "response", kind: "field" as const }],
      depsHittingPath("src/models/car.rating.model.ts", RATING_MODEL_BODY),
    );
    expect(out[0].exists).toBe(true);
    expect(out[0].evidence?.hit_type).toBe("field");
  });
});
