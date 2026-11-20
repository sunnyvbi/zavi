import { describe, expect, it } from "vitest";
import { filterArtifacts } from "./filterArtifacts";
import type { Artifact } from "./types";

function artifact(id: string, over: Partial<Artifact>): Artifact {
  return {
    id,
    run_id: "run-1",
    title: id,
    filename: `${id}.pdf`,
    mime: "application/pdf",
    type: "document",
    bytes: 10,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    preview_url: null,
    source: { kind: "task", id: "run-1", title: "Agent task", href: "/workspace/runs/run-1" },
    ...over,
  };
}

const list = [
  artifact("deck", { title: "Launch Deck", filename: "launch-deck.pdf" }),
  artifact("hero", { title: "Hero image", filename: "hero.png", mime: "image/png", type: "image" }),
  artifact("blog", { title: "Blog draft", filename: "seo-post.html", mime: "text/html", type: "website" }),
];

describe("filterArtifacts (#13 client-side search)", () => {
  it("returns the same list untouched with no query and no type", () => {
    expect(filterArtifacts(list, "  ", "all")).toBe(list);
  });

  it("matches title or filename, case-insensitive and trimmed", () => {
    expect(filterArtifacts(list, "  LAUNCH ", "all").map((a) => a.id)).toEqual(["deck"]);
    expect(filterArtifacts(list, "seo-post", "all").map((a) => a.id)).toEqual(["blog"]);
  });

  it("filters by artifact type", () => {
    expect(filterArtifacts(list, "", "image").map((a) => a.id)).toEqual(["hero"]);
  });

  it("combines type and query", () => {
    expect(filterArtifacts(list, "hero", "document")).toEqual([]);
    expect(filterArtifacts(list, "hero", "image").map((a) => a.id)).toEqual(["hero"]);
  });

  it("caps the query at 120 characters like the server", () => {
    const long = "launch".padEnd(200, "x");
    expect(filterArtifacts(list, long, "all")).toEqual([]);
  });
});
