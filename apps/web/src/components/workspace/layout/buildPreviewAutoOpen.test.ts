import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isAppWorkspaceTarget,
  contextAutoCollapseOnPreview,
  AUTO_OPEN_MIN_PX,
  ASK_FOR_CHANGES_PLAN,
  buildPreviewStamp,
  previewSteppedAside,
  composerReachableAfter,
  dismissalAfterClose,
  shouldAutoOpenPreview,
  shouldOpenTargetPreview,
  NOTHING_DISMISSED,
} from "./buildPreviewAutoOpen";
import { BUILD_SPLIT_MIN_PX } from "./buildSplit";

const SESSION = "run-1";

const wide = {
  hasProgress: true,
  splitWide: true,
  sessionId: SESSION,
  dismissedFor: null,
};

describe("auto-opening the build preview", () => {
  it("opens beside the chat as soon as the run reports stages", () => {
    expect(shouldAutoOpenPreview(wide)).toBe(true);
  });

  it("never opens itself on a phone, where the panel covers the whole surface", () => {
    expect(shouldAutoOpenPreview({ ...wide, splitWide: false })).toBe(false);
  });

  it("opens the moment a narrow window is widened past the split", () => {
    const narrow = { ...wide, splitWide: false };
    expect(shouldAutoOpenPreview(narrow)).toBe(false);
    expect(shouldAutoOpenPreview({ ...narrow, splitWide: true })).toBe(true);
  });

  it("stays shut for the session the founder closed it on", () => {
    expect(shouldAutoOpenPreview({ ...wide, dismissedFor: SESSION })).toBe(false);
  });

  it("opens again for the next build, even after the last one was closed", () => {
    expect(
      shouldAutoOpenPreview({ ...wide, sessionId: "run-2", dismissedFor: SESSION }),
    ).toBe(true);
  });

  it("waits for stages before opening anything", () => {
    expect(shouldAutoOpenPreview({ ...wide, hasProgress: false })).toBe(false);
  });

  it("uses the same width as the chat | preview split, so it can never open into an overlay", () => {
    expect(AUTO_OPEN_MIN_PX).toBe(BUILD_SPLIT_MIN_PX);
  });
});

describe("what closing the preview means", () => {
  it("a founder pressing close keeps it closed for that run", () => {
    expect(dismissalAfterClose("user", SESSION, null)).toBe(SESSION);
  });

  it("leaving the Build tab does NOT count as closing it", () => {
    expect(dismissalAfterClose("surface", SESSION, null)).toBeNull();
    expect(
      shouldAutoOpenPreview({
        ...wide,
        dismissedFor: dismissalAfterClose("surface", SESSION, null),
      }),
    ).toBe(true);
  });

  it("a tab switch after a real close does not revive the preview", () => {
    const afterClose = dismissalAfterClose("user", SESSION, null);
    const afterSwitch = dismissalAfterClose("surface", SESSION, afterClose);
    expect(afterSwitch).toBe(SESSION);
    expect(shouldAutoOpenPreview({ ...wide, dismissedFor: afterSwitch })).toBe(false);
  });
});

describe("shouldOpenTargetPreview — a servable link opens the pane by itself", () => {
  const link = {
    splitWide: true,
    sessionId: SESSION,
    dismissedFor: null as string | null,
    openForSession: false,
  };

  it("opens on a link alone, with no build in flight", () => {
    expect(shouldOpenTargetPreview(link)).toBe(true);
  });

  it("stays shut on a narrow viewport, where the pane would cover the chat", () => {
    expect(shouldOpenTargetPreview({ ...link, splitWide: false })).toBe(false);
  });

  it("never reopens over a close the user made for this build", () => {
    expect(shouldOpenTargetPreview({ ...link, dismissedFor: SESSION })).toBe(false);
  });

  it("reopens for the next build, since the dismissal was for the old one", () => {
    expect(
      shouldOpenTargetPreview({ ...link, sessionId: "run-2", dismissedFor: SESSION }),
    ).toBe(true);
  });

  it("fills a pane already open for this build even when the rules would not open one", () => {
    expect(
      shouldOpenTargetPreview({
        ...link,
        splitWide: false,
        dismissedFor: SESSION,
        openForSession: true,
      }),
    ).toBe(true);
  });
});

describe("a build tab that is not yet bound to a session", () => {
  const unbound = {
    hasProgress: true,
    splitWide: true,
    sessionId: null,
    dismissedFor: NOTHING_DISMISSED,
  };

  it("opens on progress, because nothing has been dismissed yet", () => {
    expect(shouldAutoOpenPreview(unbound)).toBe(true);
  });

  it("opens on a servable link, because nothing has been dismissed yet", () => {
    expect(
      shouldOpenTargetPreview({
        splitWide: true,
        sessionId: null,
        dismissedFor: NOTHING_DISMISSED,
        openForSession: false,
      }),
    ).toBe(true);
  });

  it("still honours a close the founder made while it was unbound", () => {
    const afterClose = dismissalAfterClose("user", null, NOTHING_DISMISSED);
    expect(shouldAutoOpenPreview({ ...unbound, dismissedFor: afterClose })).toBe(false);
    expect(
      shouldOpenTargetPreview({
        splitWide: true,
        sessionId: null,
        dismissedFor: afterClose,
        openForSession: false,
      }),
    ).toBe(false);
  });

  it("opens again once the run binds an id to the tab", () => {
    const afterClose = dismissalAfterClose("user", null, NOTHING_DISMISSED);
    expect(
      shouldAutoOpenPreview({ ...unbound, sessionId: "run-1", dismissedFor: afterClose }),
    ).toBe(true);
  });

  it("does not treat a dismissal for a real run as one for the unbound tab", () => {
    expect(
      shouldAutoOpenPreview({ ...unbound, dismissedFor: dismissalAfterClose("user", "run-1", NOTHING_DISMISSED) }),
    ).toBe(true);
  });

  it("starts from a sentinel that is not a session id any tab can carry", () => {
    expect(NOTHING_DISMISSED).toBeUndefined();
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    expect(src).toMatch(/useRef<PreviewDismissal>\(NOTHING_DISMISSED\)/);
  });
});

describe("how the workspace wires it", () => {
  const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");

  it("gates the auto-open on the live split width, not on progress alone", () => {
    expect(src).toMatch(/shouldAutoOpenPreview\(\{[\s\S]{0,200}splitWide: buildSplitWide/);
  });

  it("routes the link-driven open through the same width and dismissal policy", () => {
    expect(src).toMatch(/shouldOpenTargetPreview\(\{[\s\S]{0,240}splitWide: buildSplitWide/);
    expect(src).toMatch(/shouldOpenTargetPreview\(\{[\s\S]{0,240}dismissedFor: previewDismissedForRef\.current/);
  });

  it("treats leaving the build surface as a hide, and the close button as a dismissal", () => {
    expect(src).toMatch(/if \(!buildSurface && previewOpen\) hideBuildPreview\("surface"\)/);
    expect(src).toMatch(/hideBuildPreview\("user"\)/);
  });

  it("clears the stepped-aside stamp when the bound session changes or resets", () => {
    expect(src).toMatch(
      /buildPreview\.sessionId !== buildSessionId\)[\s\S]{0,900}setPreviewHiddenAt\(null\)/,
    );
    expect(src).toMatch(/resetBuild = useCallback\(\(\) => \{[\s\S]{0,400}setPreviewHiddenAt\(null\)/);
  });
});

describe("Ask for changes", () => {
  const MODES = [
    { splitWide: true, chatCollapsed: false, name: "split, chat already open" },
    { splitWide: true, chatCollapsed: true, name: "split, chat collapsed" },
    { splitWide: false, chatCollapsed: false, name: "overlay, chat open behind it" },
    { splitWide: false, chatCollapsed: true, name: "overlay, chat collapsed" },
  ];

  it("puts the composer in front of the founder from every state the button is reachable in", () => {
    for (const mode of MODES) {
      expect(
        composerReachableAfter(mode, ASK_FOR_CHANGES_PLAN),
        `${mode.name}: the composer is still hidden after Ask for changes, so the button reads as dead`,
      ).toBe(true);
    }
  });

  it("hands the pane back to the chat at every width, not only under the overlay", () => {
    expect(ASK_FOR_CHANGES_PLAN.closePreview).toBe(true);
  });

  it("is not the founder dismissing the preview, so the next run still opens it", () => {
    const afterAsk = dismissalAfterClose("surface", SESSION, NOTHING_DISMISSED);
    expect(shouldAutoOpenPreview({ ...wide, dismissedFor: afterAsk })).toBe(true);
    const afterClose = dismissalAfterClose("user", SESSION, NOTHING_DISMISSED);
    expect(shouldAutoOpenPreview({ ...wide, dismissedFor: afterClose })).toBe(false);
  });

  it("retired with the old preview panel: the layout carries no Ask for changes handler, the workspace chat is the way to ask", () => {
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    expect(src).not.toMatch(/const editBuild = useCallback/);
    expect(src).not.toMatch(/ASK_FOR_CHANGES_PLAN/);
    expect(src).not.toMatch(/BuildPreviewPanel\b(?!")|BuildPreviewPlaceholder/);
  });

  it("leaves the running app mounted while the chat is in front of it", () => {
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    expect(
      src,
      "the preview subtree is gated on visibility, so stepping aside unmounts the iframe and reloads the app",
    ).toMatch(/\{previewMounted && \(/);
    expect(src).toMatch(/const previewMounted = previewOpen && buildSurface;/);
    expect(src).toMatch(/const showBuildPreview = previewMounted && !previewHidden;/);
    expect(src).not.toMatch(/\{showBuildPreview && \(/);
  });

  it("leaving the preview up buries the composer, which is the bug this replaced", () => {
    const keepPreviewUp = { closePreview: false, expandChat: true };
    for (const mode of MODES.filter((m) => !m.splitWide)) {
      expect(
        composerReachableAfter(mode, keepPreviewUp),
        `${mode.name}: an overlay over the chat leaves nothing to focus`,
      ).toBe(false);
    }
  });

  it("a split-view plan that only moves the caret changes nothing the founder can see", () => {
    const focusOnly = { closePreview: false, expandChat: false };
    expect(
      composerReachableAfter({ splitWide: true, chatCollapsed: true }, focusOnly),
    ).toBe(false);
  });
});

describe("stepping the preview aside instead of tearing it down", () => {
  const live = { url: "https://upcarai-6ec4d609.onrender.com", revision: "r7" };

  it("keeps the app hidden for exactly as long as it is the same build", () => {
    const hiddenAt = buildPreviewStamp(live);
    expect(previewSteppedAside(hiddenAt, buildPreviewStamp(live))).toBe(true);
    expect(previewSteppedAside(hiddenAt, buildPreviewStamp(live))).toBe(true);
  });

  it("shows the preview again the moment the founder's change is deployed", () => {
    const hiddenAt = buildPreviewStamp(live);
    expect(previewSteppedAside(hiddenAt, buildPreviewStamp({ ...live, revision: "r8" }))).toBe(false);
    expect(previewSteppedAside(hiddenAt, buildPreviewStamp({ ...live, url: "https://other.onrender.com" }))).toBe(false);
  });

  it("treats a build with no revision yet as its own build, not as every build", () => {
    const unversioned = buildPreviewStamp({ url: live.url });
    expect(unversioned).not.toBeNull();
    expect(previewSteppedAside(unversioned, buildPreviewStamp({ url: live.url }))).toBe(true);
    expect(previewSteppedAside(unversioned, buildPreviewStamp(live))).toBe(false);
  });

  it("never hides a preview nobody stepped aside from", () => {
    expect(previewSteppedAside(null, buildPreviewStamp(live))).toBe(false);
    expect(previewSteppedAside(null, null)).toBe(false);
  });

  it("comes back when the founder opens the same build again from the chat", () => {
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    const open = src.match(/const openBuildPreview = useCallback\(([\s\S]*?)\n  \);/);
    expect(open, "openBuildPreview is no longer a useCallback the test can read").not.toBeNull();
    expect(
      open![1],
      "the preview card's Open re-supplies the same target, so the same stamp keeps it stepped aside and the button reads as dead",
    ).toMatch(/setPreviewHiddenAt\(null\)/);
  });

  it("is keyed off the same two fields that force the iframe to remount", () => {
    const tab = readFileSync(join(__dirname, "../WebsiteTab.tsx"), "utf8");
    const key = tab.match(/key=\{`\$\{websitePreviewKey\(frameUrl, (?:liveFramed \? 0 : )?previewReloadKey\)\}[^`]*`\}/)?.[0];
    expect(key, "the preview iframe no longer keys off the framed URL").toBeTruthy();
    expect(
      key,
      "the iframe reloads on a field buildPreviewStamp ignores, so a stepped-aside preview could outlive its own reload",
    ).toMatch(/appRevision/);
    const layout = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    expect(layout).toMatch(/appRevision=\{buildPreview\?\.target\.revision \?\? null\}/);
  });
});

describe("the founder clicking Open on the build card", () => {
  const SESSION = "s-open";

  it("is refused by the auto-open policy once that session was dismissed", () => {
    const dismissed = dismissalAfterClose("user", SESSION, NOTHING_DISMISSED);
    expect(
      shouldOpenTargetPreview({
        splitWide: true,
        sessionId: SESSION,
        dismissedFor: dismissed,
        openForSession: false,
      }),
      "this is the gate a click must not be subject to — closing once would kill Open for the session",
    ).toBe(false);
  });

  it("carries an explicit intent, so the click is not mistaken for the auto-supply effect", () => {
    const pane = readFileSync(resolve(__dirname, "../build/BuildModePane.tsx"), "utf8");
    expect(pane).toMatch(/onOpen=\{\(\) => onOpenPreview\(target, "user"\)\}/);
    expect(
      pane,
      "the effect that re-supplies the target must stay intent-free, or every render reopens a preview the founder stepped aside from",
    ).toMatch(/\n      onOpenPreview\(target\);\n/);
  });

  it("bypasses the dismissal gate and clears the step-aside, but only for a click", () => {
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    const open = src.match(/\(target: BuildPreviewTarget, intent\?: "user"\) => \{([\s\S]*?)\n    \},/);
    expect(open, "openBuildPreview no longer takes an intent").not.toBeNull();
    const body = open![1];
    expect(body).toMatch(/intent !== "user" &&\s*\n?\s*!shouldOpenTargetPreview/);
    expect(body).toMatch(/if \(intent === "user"\) \{[\s\S]*?previewDismissedForRef\.current = NOTHING_DISMISSED;[\s\S]*?setPreviewHiddenAt\(null\);[\s\S]*?\}/);
    expect(
      body,
      "an unconditional clear here cancels Ask for changes on the very next render",
    ).not.toMatch(/\n      setPreviewHiddenAt\(null\);\n      setPreviewPending/);
  });
});

describe("the live app gets the app workspace", () => {
  it("is the build's own live verdict, not any servable preview", () => {
    expect(isAppWorkspaceTarget({ status: "live", kind: "early" })).toBe(true);
    expect(isAppWorkspaceTarget({ status: "none", kind: "final" })).toBe(true);
    expect(isAppWorkspaceTarget({ status: "building", kind: "instant" })).toBe(false);
    expect(isAppWorkspaceTarget({ status: "failed", kind: "early" })).toBe(false);
    expect(isAppWorkspaceTarget(null)).toBe(false);
  });

  it("renders the workspace in the preview slot and opens it on any width", () => {
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    const slot = src.slice(src.indexOf("{previewMounted && ("));
    expect(slot).toMatch(/<AppWorkspace\s+variant="build"\s+appUrl=\{buildPreview\?\.target\.url \?\? null\}\s+appUrlLive=\{appWorkspace\}/);
    expect(slot, "every preview state goes through the one browser chrome").not.toMatch(/BuildPreviewPanel|BuildPreviewPlaceholder/);
    expect(src).toMatch(/openForSession: previewPending \|\| isAppWorkspaceTarget\(target\)/);
  });
});

describe("the context rail folds when a preview takes the room", () => {
  const openOverExpandedNav = {
    previewOpen: true,
    contextHidden: false,
    previous: false,
  };

  it("folds the nav the moment any preview opens", () => {
    expect(contextAutoCollapseOnPreview(openOverExpandedNav)).toBe(true);
  });

  it("folds for a live app's workspace, not only the build render", () => {
    const live = { status: "live", kind: "final" };
    expect(isAppWorkspaceTarget(live)).toBe(true);
    expect(contextAutoCollapseOnPreview(openOverExpandedNav)).toBe(true);
  });

  it("stays folded across the build-render to app-workspace handover", () => {
    const rendering = contextAutoCollapseOnPreview(openOverExpandedNav);
    const live = contextAutoCollapseOnPreview({
      ...openOverExpandedNav,
      previous: rendering,
    });
    expect([rendering, live]).toEqual([true, true]);
  });

  it("gives the nav back when the preview closes", () => {
    expect(
      contextAutoCollapseOnPreview({
        previewOpen: false,
        contextHidden: false,
        previous: true,
      }),
    ).toBe(false);
  });

  it("claims nothing it cannot give back when the nav was already folded by preference", () => {
    expect(
      contextAutoCollapseOnPreview({
        previewOpen: true,
        contextHidden: true,
        previous: false,
      }),
    ).toBe(false);
  });

  it("never writes the stored preference", () => {
    const src = readFileSync(resolve(__dirname, "./WorkspaceLayout.tsx"), "utf8");
    const effect = src.slice(
      src.indexOf("const [contextAutoCollapsed"),
      src.indexOf("const appWorkspaceSessionRef"),
    );
    expect(effect).toMatch(/contextAutoCollapseOnPreview/);
    expect(effect).not.toMatch(/setContextHidden/);
    expect(effect).not.toMatch(/appWorkspace/);
  });
});
