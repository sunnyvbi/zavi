import { expect, it } from "vitest";
import { instagramChrome, instagramTables } from "./instagramTables";
import { PLATFORMS } from "../actions/platforms";

it("an unconnected account gets no banner sentence, and a real read problem still shows", () => {
  expect(instagramChrome({ connected: false, metrics: [] })?.problem).toBeNull();
  expect(instagramChrome({ connected: true, metrics: [], problem: "Instagram refused the read." })?.problem).toEqual({ text: "Instagram refused the read.", reconnect: false });
});

it("the Instagram page asks for four tiles across and no strategy prompt", () => {
  expect(PLATFORMS.instagram_organic.metricLayout?.perRow).toBe(4);
  expect(PLATFORMS.instagram_organic.hideStrategyPrompt).toBe(true);
});

it("keeps the Top posts table on the page when there are no posts", () => {
  const [table] = instagramTables({ connected: false, metrics: [], top_posts: [] });
  expect(table).toMatchObject({ title: "Top posts", keepWhenEmpty: true, rows: [], empty: "No posts to show yet." });
  expect(instagramTables({ connected: true, metrics: [] })).toEqual([]);
});
