import { expect, it } from "vitest";
import { channelCardPool } from "./channelCardPool";
import { chatgpt_ads } from "./platforms/chatgpt_ads";
import { makeAction } from "./__tests__/fixtures";

it("keeps executable proposals actionable while retiring unassigned manual recommendations", () => {
  const executable = makeAction("text_post", { executable: true });
  const outdated = makeAction("text_post");
  const customer = makeAction("text_post", { body: { step: { responsibility: "client" } } });
  const operator = makeAction("text_post", { body: { step: { responsibility: "zavi" } } });
  const pool = channelCardPool(chatgpt_ads, null, [executable, outdated, customer, operator], new Set());

  expect(pool.customerActions).toEqual([executable, customer]);
  expect(pool.outdatedActions).toEqual([outdated]);
  expect(pool.operatorNotes).toEqual([operator]);
});
