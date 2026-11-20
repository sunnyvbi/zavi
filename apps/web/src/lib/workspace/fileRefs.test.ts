import { describe, expect, it } from "vitest";
import { appendFileRefs, mergeFileRefs, splitFileRefs } from "./fileRefs";

const T = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const url = (id: string, name: string) =>
  `http://localhost:3011/api/public/workspace-files/${T}/${id}/${name}`;
const hero = { name: "#wallpaper #musashi.jpeg", url: url("cd9ec0c2-1c87-483f-9930-4a18bc701015", "wallpaper-musashi.jpeg") };
const team = { name: "team.png", url: url("aaaaaaaa-1c87-483f-9930-4a18bc701015", "team.png") };

describe("fileRefs", () => {
  it("round-trips photos with and without typed text, names that contain colons included", () => {
    const odd = { name: "a: b.png", url: team.url };
    for (const text of ["", "make the hero use these"]) {
      const sent = appendFileRefs(text, [hero, odd]);
      expect(splitFileRefs(sent)).toEqual({ body: text, files: [hero, odd] });
    }
    expect(appendFileRefs("", [hero])).toBe(`Use this photo on the site:\n${hero.name}: ${hero.url}`);
  });

  it("reads messages sent before chips existed, collection lead included", () => {
    const legacy = `Use the "landing page" photos on the site:\n${hero.name}: ${hero.url}\n${team.name}: ${team.url}`;
    expect(splitFileRefs(legacy)).toEqual({ body: "", files: [hero, team] });
  });

  it("reads a build change whose line breaks the server collapsed into spaces", () => {
    for (const text of ["", "make the hero use these"]) {
      for (const files of [[hero], [hero, team], [{ name: "draft: v2.png", url: team.url }, hero]]) {
        const flattened = appendFileRefs(text, files).replace(/\s+/g, " ");
        expect(splitFileRefs(flattened)).toEqual({ body: text, files });
      }
    }
    const collection = `Use the "landing page" photos on the site: ${hero.name}: ${hero.url} ${team.name}: ${team.url}`;
    expect(splitFileRefs(collection)).toEqual({ body: "", files: [hero, team] });
  });

  it("leaves any other link, and a lead line with no photos under it, as text", () => {
    const text = "Use this photo on the site:\nlogo: https://example.com/logo.png\nsee: https://cdn.test/api/public/workspace-files/x/y/z.png";
    expect(splitFileRefs(text)).toEqual({ body: text, files: [] });
  });

  it("merges without duplicating a photo already attached", () => {
    expect(mergeFileRefs([hero], [team, hero, team])).toEqual([hero, team]);
  });
});
