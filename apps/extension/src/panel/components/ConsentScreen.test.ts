
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CONSENT_ACCEPT_LABEL,
  CONSENT_DECLINE_LABEL,
  CONSENT_ROWS,
  CONSENT_TITLE,
  ConsentScreen,
  PRIVACY_URL,
  TERMS_URL,
} from "./ConsentScreen";

function markup(props?: { denied?: boolean; busy?: boolean; error?: string | null }): string {
  return renderToStaticMarkup(
    createElement(ConsentScreen, {
      onAccept: () => undefined,
      onDecline: () => undefined,
      busy: props?.busy ?? false,
      error: props?.error ?? null,
      denied: props?.denied ?? false,
    }),
  );
}

function screenText(props?: Parameters<typeof markup>[0]): string {
  return markup(props)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ +([.,])/g, "$1")
    .trim();
}

describe("the approved copy, verbatim, in the approved order", () => {
  it("opens on the approved title", () => {
    expect(CONSENT_TITLE).toBe("Zavi can work in this tab for you");
    expect(screenText()).toContain(CONSENT_TITLE);
  });

  it("carries exactly the five approved rows, in order, on the surface", () => {
    expect(CONSENT_ROWS.map((r) => r.text)).toEqual([
      "When you ask, Zavi clicks, types and moves around this tab using your logged-in accounts.",
      "It pauses and asks before steps that clearly spend money.",
      "It sends a screenshot of the tab with each step. People at Zavi may read what you send to improve Zavi.",
      "Press Stop or close this panel at any time to stop it.",
      "Pages can contain hidden instructions that try to make an AI act without you asking. Zavi treats what it reads as information, not orders, but be careful letting it work on sites you do not trust.",
    ]);
    const text = screenText();
    for (const row of CONSENT_ROWS) expect(text).toContain(row.text);
    expect(markup().match(/<li[^>]*>/g)?.length).toBe(5);
  });

  it("ends on the hidden-instructions warning, in the warning tone", () => {
    const last = CONSENT_ROWS[CONSENT_ROWS.length - 1];
    expect(last.key).toBe("hidden-instructions");
    expect(last.tone).toBe("warn");
    expect(CONSENT_ROWS.filter((r) => r.tone === "warn")).toHaveLength(1);
    expect(markup().match(/zv-row-warn/g)?.length).toBe(1);
  });

  it("labels the buttons Allow and Not now", () => {
    expect(CONSENT_ACCEPT_LABEL).toBe("Allow");
    expect(CONSENT_DECLINE_LABEL).toBe("Not now");
    expect(screenText()).toContain("Allow");
    expect(screenText()).toContain("Not now");
    expect(markup()).toContain("zv-primary-pill");
  });

  it("no longer promises that Zavi never clicks, types or changes anything", () => {
    const text = screenText().toLowerCase();
    expect(text).not.toContain("never clicks");
    expect(text).not.toContain("does not click");
    expect(text).not.toContain("never changes anything");
    expect(markup()).not.toMatch(/<details/);
  });
});

describe("the permission moment", () => {
  it("warns before the click that Chrome is about to ask", () => {
    expect(screenText()).toContain("Chrome will ask you to confirm.");
  });
});

describe("the legal footnote points at the live pages and leaves the panel alone", () => {
  it("uses the live Terms and Privacy URLs", () => {
    expect(TERMS_URL).toBe("https://www.zaviagent.com/terms");
    expect(PRIVACY_URL).toBe("https://www.zaviagent.com/privacy");
    expect(screenText()).toContain(
      "By continuing you agree to the Terms and Privacy Policy.",
    );
  });

  it("opens both in a NEW tab: a side panel that navigates away is a dead panel", () => {
    const anchors = markup().match(/<a\b[^>]*>/g) ?? [];
    expect(anchors).toHaveLength(2);
    const hrefs = anchors.map((a) => /href="([^"]+)"/.exec(a)?.[1]);
    expect(hrefs).toEqual([TERMS_URL, PRIVACY_URL]);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain("noopener");
      expect(a).toContain("noreferrer");
    }
  });
});

describe("the refused state is a retry, not a dead end", () => {
  it("says what happened, that nothing was recorded, and how to get back", () => {
    const text = screenText({ denied: true });
    expect(text).toContain("Chrome did not grant access");
    expect(text).toContain("Nothing was sent and nothing was recorded.");
    expect(text).toContain("set site access to all sites");
    expect(text).toContain("Ask Chrome again");
  });

  it("keeps a way out of the screen", () => {
    expect(markup({ denied: true })).toContain("zv-consent-decline");
  });

  it("says Chrome is being asked while it waits", () => {
    expect(screenText({ busy: true })).toContain("Waiting for Chrome...");
    expect(screenText({ busy: true })).toContain("Chrome is asking for site access.");
  });
});

describe("house rules", () => {
  it("has no em dashes in any state", () => {
    expect(screenText()).not.toContain("—");
    expect(screenText({ denied: true })).not.toContain("—");
    expect(screenText({ busy: true })).not.toContain("—");
    expect(screenText({ error: "Something went wrong." })).not.toContain("—");
  });

  it("keeps the primary and the quiet action in every state, so nothing traps the person", () => {
    for (const state of [{}, { busy: true }, { denied: true }, { error: "boom" }]) {
      const html = markup(state);
      expect(html).toContain("zv-consent-accept");
      expect(html).toContain("zv-consent-decline");
    }
  });

  it("keeps all five rows, warning included, in every state", () => {
    for (const state of [{}, { busy: true }, { denied: true }, { error: "boom" }]) {
      const text = screenText(state);
      for (const row of CONSENT_ROWS) expect(text).toContain(row.text);
      expect(markup(state)).toContain("zv-row-warn");
    }
  });
});
