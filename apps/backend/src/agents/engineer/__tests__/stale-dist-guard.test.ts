import { describe, expect, it } from "vitest";
import { detectStaleDeployedDist } from "../stale-dist-guard";

describe("detectStaleDeployedDist", () => {
  const evidence = "CMD [\"node\", \"apps/backend/dist/server.js\"]";

  it("blocks a source change whose tracked deployed dist file is stale", () => {
    expect(
      detectStaleDeployedDist({
        changed_paths: ["apps/backend/src/routes/chat.ts"],
        tracked_paths: ["apps/backend/dist/routes/chat.js"],
        deployment_evidence: evidence,
      }),
    ).toEqual({
      stale: true,
      source_paths: ["apps/backend/src/routes/chat.ts"],
      expected_dist_paths: ["apps/backend/dist/routes/chat.js"],
    });
  });

  it("allows the change when the matching dist output changed", () => {
    expect(
      detectStaleDeployedDist({
        changed_paths: [
          "apps/backend/src/routes/chat.ts",
          "apps/backend/dist/routes/chat.js",
        ],
        tracked_paths: ["apps/backend/dist/routes/chat.js"],
        deployment_evidence: evidence,
      }),
    ).toEqual({ stale: false });
  });

  it("does not impose dist on repositories whose deployment builds source", () => {
    expect(
      detectStaleDeployedDist({
        changed_paths: ["src/index.ts"],
        tracked_paths: ["dist/index.js"],
        deployment_evidence: "npm run build && node server.js",
      }),
    ).toEqual({ stale: false });
  });

  it("F8 — exempts a deploy that BUILDS then runs dist (the build regenerates it)", () => {
    expect(
      detectStaleDeployedDist({
        changed_paths: ["apps/backend/src/routes/chat.ts"],
        tracked_paths: ["apps/backend/dist/routes/chat.js"],
        deployment_evidence:
          'RUN npm run build\nCMD ["node", "apps/backend/dist/server.js"]',
      }),
    ).toEqual({ stale: false });
  });

  it("F8 — still blocks when the deploy runs committed dist with NO build step", () => {
    expect(
      detectStaleDeployedDist({
        changed_paths: ["apps/backend/src/routes/chat.ts"],
        tracked_paths: ["apps/backend/dist/routes/chat.js"],
        deployment_evidence: 'CMD ["node", "apps/backend/dist/server.js"]',
      }).stale,
    ).toBe(true);
  });
});
