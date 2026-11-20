import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import Page from "../page";

describe("/workspace/legacy", () => {
  it("redirects to /workspace", () => {
    Page({});
    expect(redirect).toHaveBeenLastCalledWith("/workspace");
  });

  it("keeps the query string", () => {
    Page({ searchParams: { agent: "seo-geo", tab: ["a", "b"] } as never });
    expect(redirect).toHaveBeenLastCalledWith("/workspace?agent=seo-geo&tab=a&tab=b");
  });
});
