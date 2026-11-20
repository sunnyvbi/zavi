import { describe, expect, it } from "vitest";
import { closeUrl, drawerUrl, feesFor, overFind, readDrawer } from "./hub";

describe("UGC hub drawer URLs", () => {
  it("reads the drawer and its ids, and ignores an unknown drawer", () => {
    expect(readDrawer("?tab=channels&channel=ugc&drawer=job&job=o1&paid=1")).toEqual({
      name: "job",
      params: { job: "o1", paid: "1" },
    });
    expect(readDrawer("?drawer=nope&job=o1").name).toBeNull();
  });

  it("swaps one drawer for another without leaking the first one's ids, and closes cleanly", () => {
    const from = "/workspace?tab=channels&channel=ugc&drawer=applicants&brief=b1&hire_cancelled=1";
    expect(drawerUrl(from, "thread", { creator: "m1" })).toBe("/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1");
    expect(drawerUrl(from, null)).toBe("/workspace?tab=channels&channel=ugc");
  });

  it("prices a half-typed number with the shared fee rule, and nothing for a refused one", () => {
    expect(feesFor(15000)?.business_total_cents).toBe(16500);
    expect(feesFor(0)).toBeNull();
  });

  it("a drawer opened over Find creators keeps the search, and closing it returns there", () => {
    const find = { keyword: "cars", sort: "a_to_z" };
    const thread = overFind("thread", { creator: "m1", over: "find" }, find);
    expect(thread).toEqual({ creator: "m1", over: "find", keyword: "cars", sort: "a_to_z" });
    expect(overFind("thread", { creator: "m2" }, thread)).toEqual({ creator: "m2", over: "find", keyword: "cars", sort: "a_to_z" });
    expect(overFind("hire", { offer: "o1" }, thread)).toMatchObject({ offer: "o1", over: "find", keyword: "cars" });
    expect(closeUrl("/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1&over=find&keyword=cars&sort=a_to_z")).toBe(
      "/workspace?tab=channels&channel=ugc&drawer=find&keyword=cars&sort=a_to_z",
    );
  });

  it("a drawer not opened from Find creators closes to the channel, as before", () => {
    expect(overFind("thread", { creator: "m1" }, {})).toEqual({ creator: "m1" });
    expect(closeUrl("/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1")).toBe("/workspace?tab=channels&channel=ugc");
    expect(closeUrl("/workspace?tab=channels&channel=ugc&drawer=find&keyword=cars")).toBe("/workspace?tab=channels&channel=ugc");
  });
});
