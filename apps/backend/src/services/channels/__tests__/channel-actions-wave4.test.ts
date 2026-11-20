import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { actionsStoreFor } from "@zavi/shared";
import { ACTION_TYPE_FAMILY_SETS, deriveActionType } from "../action-type";

describe("wave 4: the channel is switched", () => {
  it("the ad channel that can move money is still not switched", () => {
    expect(actionsStoreFor("google_ads")).toBe("channel_actions");
    expect(actionsStoreFor("meta_ads")).toBe("channel_actions");
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
    expect(actionsStoreFor("tiktok_ads")).toBe("channel_actions");
  });

  it("ugc switched through its OWN branch", () => {
    expect(actionsStoreFor("ugc")).toBe("channel_actions");
    expect(
      deriveActionType("ugc", { title: "Script the three takes", deliverable: { kind: "script" } })
        .action_type,
    ).toBe("video_post");
  });
});

describe("the four action-type family sets", () => {
  const families = Object.entries(ACTION_TYPE_FAMILY_SETS);

  it("are all non-empty, so the pairwise check below is not vacuous", () => {
    expect(families.length).toBeGreaterThanOrEqual(4);
    for (const [name, set] of families) {
      expect(set.size, `${name} is empty: a branch no channel can reach`).toBeGreaterThan(0);
    }
  });

  it("are ALL of the family sets the module declares", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "action-type.ts"), "utf8");
    const declared = [...src.matchAll(/^const (\w+_FIRST_CHANNELS) = new Set/gm)].map((m) => m[1]);
    expect(declared.length, "no family sets found: this check is reading the wrong file").toBeGreaterThanOrEqual(4);
    expect(
      families.map(([name]) => `${name.toUpperCase()}_CHANNELS`).sort(),
      "a family set is missing from ACTION_TYPE_FAMILY_SETS, so nothing checks it for overlap",
    ).toEqual(declared.sort());
  });

  it("share no channel with each other", () => {
    for (let i = 0; i < families.length; i++) {
      for (let j = i + 1; j < families.length; j++) {
        const [aName, a] = families[i];
        const [bName, b] = families[j];
        const shared = [...a].filter((slug) => b.has(slug));
        expect(
          shared,
          `${aName} and ${bName} both claim ${shared.join(", ")}: the earlier branch wins silently`,
        ).toEqual([]);
      }
    }
  });
});
