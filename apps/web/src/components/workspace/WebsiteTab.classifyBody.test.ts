import { describe, expect, it } from "vitest";
import { refineSelectionOf, websiteChatClassifyBody } from "./WebsiteTab";

const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const ASK = "can you use this img\n\nUse this photo on the site:\nhero.jpeg: http://localhost:3011/api/public/workspace-files/b92dcbf1-bac9-457a-af81-0bbe5984339b/cd9ec0c2-1c87-483f-9930-4a18bc701015/hero.jpeg";

describe("websiteChatClassifyBody", () => {
  it("tells the router which build the Build tab is bound to, so an own-site product_url cannot bounce the ask to the operator", () => {
    expect(websiteChatClassifyBody(ASK, BUILD)).toEqual({ message: ASK, conductor_run_id: BUILD });
  });

  it("sends no session from the Website tab or an unbound Build tab", () => {
    expect(websiteChatClassifyBody(ASK, null)).toEqual({ message: ASK });
    expect("conductor_run_id" in websiteChatClassifyBody(ASK, null)).toBe(false);
  });

  it("marks a turn sent with a picked element as scoped, only for a bound build", () => {
    expect(websiteChatClassifyBody("bigger", BUILD, true)).toEqual({ message: "bigger", conductor_run_id: BUILD, scoped: true });
    expect(websiteChatClassifyBody("bigger", null, true)).toEqual({ message: "bigger" });
  });
});

describe("refineSelectionOf", () => {
  it("sends structure, the element's own words and its image address, nothing else", () => {
    expect(
      refineSelectionOf({ id: 3, selector: "main > img", tag: "img", text: "  ", path: "/about", src: "https://cdn.example/a.png" }),
    ).toEqual({ selector: "main > img", tag: "img", path: "/about", src: "https://cdn.example/a.png" });
    expect(refineSelectionOf({ id: 4, selector: "main > h1", tag: "h1", text: " Rent bikes ", path: "/", src: null })).toEqual({
      selector: "main > h1",
      tag: "h1",
      text: "Rent bikes",
      path: "/",
    });
  });
});
