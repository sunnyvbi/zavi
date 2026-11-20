
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { HumanBriefsIsland } from "./HumanBriefsIsland";
import { HumanBriefDetailIsland } from "./HumanBriefDetailIsland";
import { HumanEngagementIsland } from "./HumanEngagementIsland";
import { HumanJobsIsland } from "./HumanJobsIsland";
import { FindCreatorsIsland } from "./FindCreatorsIsland";
import { CreatorLibraryIsland } from "./CreatorLibraryIsland";
import { HUMAN_SECTION_TABS } from "./HumanSectionTabs";
import { readFileSync as readSrc } from "node:fs";
import { join as joinPath } from "node:path";
import { RepostBriefButton } from "./RepostBriefButton";

describe("human surfaces render", () => {
  it("briefs list renders its heading and a busy skeleton, not an empty state", () => {
    const html = renderToString(<HumanBriefsIsland />);
    expect(html).toContain("Human");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("No briefs yet");
  });

  it("brief detail renders both views as real links", () => {
    for (const view of ["matches", "applications"] as const) {
      const html = renderToString(
        <HumanBriefDetailIsland briefId="brief_7f21" view={view} />,
      );
      expect(html).toContain('href="/humans/briefs/brief_7f21/matches"');
      expect(html).toContain('href="/humans/briefs/brief_7f21/applications"');
    }
  });

  it("engagement detail renders both views as real links", () => {
    for (const view of ["work", "receipt"] as const) {
      const html = renderToString(
        <HumanEngagementIsland engagementId="eng_4c8e21" view={view} />,
      );
      expect(html).toContain('href="/humans/engagements/eng_4c8e21"');
      expect(html).toContain('href="/humans/engagements/eng_4c8e21/receipt"');
    }
  });

  it("every page in the section paints the same four tabs, with its own current", () => {
    expect(HUMAN_SECTION_TABS.map((t) => t.href)).toEqual([
      "/humans",
      "/humans/jobs",
      "/humans/creators",
      "/humans/library",
    ]);

    const pages = [
      { active: "/humans", html: renderToString(<HumanBriefsIsland />) },
      { active: "/humans/jobs", html: renderToString(<HumanJobsIsland />) },
      { active: "/humans/creators", html: renderToString(<FindCreatorsIsland />) },
      { active: "/humans/library", html: renderToString(<CreatorLibraryIsland />) },
    ];

    for (const page of pages) {
      for (const tab of HUMAN_SECTION_TABS) {
        expect(page.html, `${page.active} is missing the ${tab.label} tab`).toContain(
          `href="${tab.href}"`,
        );
      }
      expect(page.html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
    }
  });

  it("ids with URL-hostile characters are encoded into the deep link", () => {
    const html = renderToString(
      <HumanBriefDetailIsland briefId="a b/c" view="matches" />,
    );
    expect(html).toContain("href=\"/humans/briefs/a%20b%2Fc/matches\"");
  });
});

describe("posted brief: close and repost, never edit in place", () => {
  it("the repost button renders its label", () => {
    expect(renderToString(<RepostBriefButton briefId="b-1" />)).toContain("Close and repost");
  });

  it("repost posts to the repost route and opens the NEW draft", () => {
    const src = readSrc(joinPath(__dirname, "RepostBriefButton.tsx"), "utf8");
    expect(src).toContain("/repost`");
    expect(src).toContain('method: "POST"');
    expect(src).toMatch(/\/humans\/briefs\/\$\{encodeURIComponent\(nextId\)\}\/post/);
  });

  it("both brief screens gate on posted_at: repost when posted, and the edit screen sends no PATCH", () => {
    const applicants = readSrc(joinPath(__dirname, "HumanBriefApplicantsIsland.tsx"), "utf8");
    expect(applicants.match(/posted_at \? \(\s*<RepostBriefButton/g)?.length).toBe(2);
    const post = readSrc(joinPath(__dirname, "HumanBriefPostIsland.tsx"), "utf8");
    const guard = post.indexOf("if (view?.creator_preview.posted_at) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post.indexOf('method: "PATCH"'));
    expect(post).toContain("<RepostBriefButton");
  });
});
