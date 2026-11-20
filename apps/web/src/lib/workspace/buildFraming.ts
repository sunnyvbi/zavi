"use client";

import { useEffect, useState } from "react";
import { BUILD_CHECKS_FAILED, BUILD_FIXES_EXHAUSTED } from "@zavi/shared";
import { apiUrl } from "@/lib/api";
import type { BuildPublish } from "@/lib/workspace/buildPublish";

type BuildFlags = {
  websiteFraming: boolean;
  ideaExamples: boolean;
  ideaAttach: boolean;
  chatToastNamed: boolean;
  siteListFirst: boolean;
  homeBuildCta: boolean;
  cookieClearOfComposer: boolean;
};

const FLAGS_DEFAULT: BuildFlags = {
  websiteFraming: true,
  ideaExamples: true,
  ideaAttach: true,
  chatToastNamed: true,
  siteListFirst: true,
  homeBuildCta: true,
  cookieClearOfComposer: true,
};

export const BUILD_FRAMING_TIMEOUT_MS = 4000;

const FLAGS_OFF: BuildFlags = {
  websiteFraming: false,
  ideaExamples: false,
  ideaAttach: false,
  chatToastNamed: false,
  siteListFirst: false,
  homeBuildCta: false,
  cookieClearOfComposer: false,
};

const FAIL_TO_DEFAULT_KEY = "zavi:build-flags-fail-to-default";

let cached: Promise<BuildFlags> | null = null;
let settled: BuildFlags | null = null;
let failToDefault: boolean | null = null;

function rememberFailToDefault(value: unknown): void {
  if (typeof value !== "boolean") return;
  failToDefault = value;
  try {
    window.localStorage.setItem(FAIL_TO_DEFAULT_KEY, value ? "1" : "0");
  } catch {
    return;
  }
}

function flagsWhenUnread(): BuildFlags {
  let off = failToDefault === false;
  if (failToDefault === null) {
    try {
      off = window.localStorage.getItem(FAIL_TO_DEFAULT_KEY) === "0";
    } catch {
      off = false;
    }
  }
  return off ? FLAGS_OFF : FLAGS_DEFAULT;
}

function flagOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

async function fetchBuildFlags(signal: AbortSignal): Promise<BuildFlags | null> {
  const res = await fetch(apiUrl("/api/public/build-framing"), { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    website_framing?: unknown;
    idea_examples?: unknown;
    idea_attach?: unknown;
    chat_toast_named?: unknown;
    site_list_first?: unknown;
    home_build_cta?: unknown;
    cookie_clear_of_composer?: unknown;
    fail_to_default?: unknown;
  };
  rememberFailToDefault(body.fail_to_default);
  return {
    websiteFraming: flagOr(body.website_framing, FLAGS_DEFAULT.websiteFraming),
    ideaExamples: flagOr(body.idea_examples, FLAGS_DEFAULT.ideaExamples),
    ideaAttach: flagOr(body.idea_attach, FLAGS_DEFAULT.ideaAttach),
    chatToastNamed: flagOr(body.chat_toast_named, FLAGS_DEFAULT.chatToastNamed),
    siteListFirst: flagOr(body.site_list_first, FLAGS_DEFAULT.siteListFirst),
    homeBuildCta: flagOr(body.home_build_cta, FLAGS_DEFAULT.homeBuildCta),
    cookieClearOfComposer: flagOr(body.cookie_clear_of_composer, FLAGS_DEFAULT.cookieClearOfComposer),
  };
}

function readBuildFlags(): Promise<BuildFlags> {
  if (!cached) {
    cached = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, BUILD_FRAMING_TIMEOUT_MS);
      });
      try {
        const flags = await Promise.race([fetchBuildFlags(controller.signal).catch(() => null), timedOut]);
        if (!flags) {
          cached = null;
          return flagsWhenUnread();
        }
        settled = flags;
        return settled;
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  return cached;
}

export function readWebsiteFraming(): Promise<boolean> {
  return readBuildFlags().then((f) => f.websiteFraming);
}

export function readIdeaExamples(): Promise<boolean> {
  return readBuildFlags().then((f) => f.ideaExamples);
}

export function readIdeaAttach(): Promise<boolean> {
  return readBuildFlags().then((f) => f.ideaAttach);
}

export function readChatToastNamed(): Promise<boolean> {
  return readBuildFlags().then((f) => f.chatToastNamed);
}

export function readSiteListFirst(): Promise<boolean> {
  return readBuildFlags().then((f) => f.siteListFirst);
}

export function readHomeBuildCta(): Promise<boolean> {
  return readBuildFlags().then((f) => f.homeBuildCta);
}

export function readCookieClearOfComposer(): Promise<boolean> {
  return readBuildFlags().then((f) => f.cookieClearOfComposer);
}

export function resetWebsiteFramingForTests(): void {
  cached = null;
  settled = null;
  failToDefault = null;
}

function useBuildFlag(
  read: () => Promise<boolean>,
  active: boolean,
  peek?: () => boolean | null,
): boolean | null {
  const [on, setOn] = useState<boolean | null>(() => (peek ? peek() : null));
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void read().then((v) => {
      if (!cancelled) setOn(v);
    });
    return () => {
      cancelled = true;
    };
  }, [active, read]);
  return active ? on : null;
}

function peekWebsiteFraming(): boolean | null {
  return settled ? settled.websiteFraming : null;
}

export function useWebsiteFraming(active = true): boolean | null {
  return useBuildFlag(readWebsiteFraming, active, peekWebsiteFraming);
}

export function useIdeaExamples(active = true): boolean | null {
  return useBuildFlag(readIdeaExamples, active);
}

function peekSiteListFirst(): boolean | null {
  return settled ? settled.siteListFirst : null;
}

export function useSiteListFirst(active = true): boolean | null {
  return useBuildFlag(readSiteListFirst, active, peekSiteListFirst);
}

export const IDEA_TOO_SHORT_HINT =
  "Add a few more words so Zavi knows what to build, for example what the site is for.";

export const IDEA_EXAMPLES_LABEL = "Or start from an example";

export const IDEA_EXAMPLES: { label: string; idea: string }[] = [
  {
    label: "Bakery website",
    idea: "A website for my bakery with the menu, opening hours and a contact form.",
  },
  {
    label: "Dog grooming bookings",
    idea: "A booking site for my dog grooming shop where customers pick a service and a time slot.",
  },
  {
    label: "Photography portfolio",
    idea: "A portfolio site for my photography with a gallery and an enquiry form.",
  },
  {
    label: "Yoga studio timetable",
    idea: "A site for my yoga studio with the class timetable, prices and a sign-up form.",
  },
];

export const WEBSITE_AUTH_HEADLINE = "Tell Zavi your idea. Zavi builds your website.";

export const WEBSITE_AUTH_CHECKS: string[] = [
  "Builds your site from your words.",
  "Puts it live on its own address.",
  "Changes it whenever you ask in chat.",
];

export const WEBSITE_COMMIT_TITLE = "Starting your website build";

export const WEBSITE_COMMIT_BODY = "Your idea is saved. The build opens here in a few seconds.";

export const WEBSITE_COMPOSER_HINTS = [
  "Describe a change to your site",
  "Add a contact form to the home page",
  "Change the colours to match my brand",
  "Add a page with my prices",
];

export const WEBSITE_BUILD_SUGGESTIONS = [
  "Describe the website you want",
  "Build a one-page site for my business",
  "Add a booking form to my site",
];

export const SITE_LIST_TITLE = "Your sites";

export const SITE_LIST_NEW = "New site";

export function useIdeaAttach(active = true): boolean | null {
  return useBuildFlag(readIdeaAttach, active);
}

export function useHomeBuildCta(active = true): boolean | null {
  return useBuildFlag(readHomeBuildCta, active, () => (settled ? settled.homeBuildCta : null));
}

export function useCookieClearOfComposer(active = true): boolean | null {
  return useBuildFlag(readCookieClearOfComposer, active, () => (settled ? settled.cookieClearOfComposer : null));
}

export const BUILD_EXPECTED_DURATION_ON_REQUEST = "Your app shows up in the preview when it's ready";

export const BUILD_READY_UNPUBLISHED = "Your preview is ready. Publishing runs a final check, then puts it live.";

export const PUBLISH_CHECK_FIXING = "Publishing stopped: the final check failed, we're fixing it.";

export const PUBLISH_CHECK_FAILED = "Publishing stopped: the final check failed.";

const CHECK_FAILURE_REASONS: ReadonlySet<string> = new Set([BUILD_CHECKS_FAILED, BUILD_FIXES_EXHAUSTED]);

export function publishCheckLine(publish: BuildPublish | null | undefined): string | null {
  if (!publish) return null;
  if (publish.status === "publishing" && publish.fixing) return PUBLISH_CHECK_FIXING;
  if (publish.status === "failed" && publish.reason && CHECK_FAILURE_REASONS.has(publish.reason)) return PUBLISH_CHECK_FAILED;
  return null;
}

export const PUBLISH_TRY_AGAIN_HINT = "Press Publish to try again.";

export const BUILD_STOPPED_TITLE = "Build stopped";

export const BUILD_STOPPED_PREVIEW = "You stopped this build before it finished, so there's nothing to preview.";

export const BUILD_START_AGAIN = "Start again";

export const BUILD_PROGRESS_BODY_ON_REQUEST =
  "Your preview shows up here once your site is fully built. When your site is built, press Publish to put it on its address.";

export const BUILD_SLOW_BODY_ON_REQUEST =
  "This build is taking longer than usual. " +
  "You can leave this page and come back.";

export const SITE_NOT_PUBLISHED = "Not published";

export const SITE_NOT_PUBLISHED_SUB = "Publish to put your site on its address.";
export const SITE_PUBLISH_PICKUP_LATE = "Your publish hasn't started yet. Press Publish to try again.";

export const SITE_NOT_BUILT_SUB = "You can publish once your site is built.";

export const SITE_PUBLISHING_TITLE = "Publishing…";

export const SITE_PUBLISHING_SUB = "Putting your site on its address. You can keep using the preview.";

export const SITE_PUBLISH_FIXING_SUB = "Fixing a problem before publishing.";

export const SITE_PUBLISH_FAILED_TITLE = "Publishing didn't finish";

export const SITE_PUBLISH_FAILED_SUB = "Your site is not on its address yet. Try again.";

export const SITE_PUBLISH_FORBIDDEN = "Viewers can't publish. Ask a workspace owner, admin or member.";

export const SITE_PUBLISH_NOT_FOUND = "We couldn't find this site. Reload the page and try again.";

export const SITE_PUBLISH_BUSY = "A build or publish is already running in this workspace. Try again when it finishes.";

export const SITE_PUBLISH_BUILDER_OFF = "Building sites isn't turned on for this workspace.";

export const SITE_PUBLISH_NOTHING_YET = "This site is still being set up, so there is nothing to publish yet.";

export const SITE_PUBLISH_SANDBOX_GONE =
  "Your site's workspace has expired. Ask for any change in the chat, then publish.";

export const SITE_PUBLISH_DAILY_LIMIT = "You've reached today's limit for changes. You can publish tomorrow.";

export const SITE_PUBLISH_BUDGET = "This workspace is out of build budget for today.";

export const SITE_ALREADY_PUBLISHED_TITLE = "Live";

export const SITE_ALREADY_PUBLISHED_SUB = "Your site is live and up to date.";

export const SITE_LIVE_ON_REQUEST_SUB = "Your site is live. Publish puts your latest changes on it.";

export const SITE_CHANGES_READY_TITLE = "Changes ready to publish";

export function siteChangesReadySub(count: number): string {
  return `${count === 1 ? "1 change is" : `${count} changes are`} in your preview. Your live site shows the last published version until you publish.`;
}

export const SITE_CHANGES_PUBLISH_FAILED_SUB = "Your live site still shows the last published version. Try again.";

export const REFINE_STRIP_ON_REQUEST = "Each change waits in your preview until you click Publish.";

export const UNDO_PREVIEW_ONLY_NOTICE = "The change was undone in your preview. Click Publish to put it live.";

export const UNDO_PREVIEW_STALE_NOTICE = "The preview may be out of date. It catches up with your next change.";

export const UNDO_PREVIEW_ONLY_CONFIRM =
  "Your preview goes back to how it was before this change. Nothing changes at your site's address until you click Publish.";

export const SITE_PUBLISH_REFUSED = "We couldn't publish your site. Try again.";

export const SITE_PUBLISH_UNREACHABLE = "We couldn't reach the server. Try again.";
