import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiUrl: (path: string) => `http://api.test${path}`, apiFetch: vi.fn() }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));

import {
  readChatToastNamed,
  readCookieClearOfComposer,
  readHomeBuildCta,
  readIdeaAttach,
  readIdeaExamples,
  readSiteListFirst,
  readWebsiteFraming,
  resetWebsiteFramingForTests,
} from "./buildFraming";
import { DEFAULT_SITE_FLAGS, DEFAULT_UI_FLAGS, readSiteFlags, readUiFlags } from "./useBuildSessions";

const REGISTRY = readFileSync(
  resolve(__dirname, "../../../../backend/src/services/settings/registry.ts"),
  "utf8",
);

function registryDefault(key: string): boolean {
  const start = REGISTRY.indexOf(`\n  ${key}: {\n`);
  if (start < 0) throw new Error(`setting ${key} is not in the registry`);
  const end = REGISTRY.indexOf("\n  },\n", start);
  const match = /\n    defaultValue: (true|false),\n/.exec(REGISTRY.slice(start, end + 1));
  if (!match) throw new Error(`setting ${key} has no boolean default`);
  return match[1] === "true";
}

const UI_FLAG_KEYS: Record<keyof typeof DEFAULT_UI_FLAGS, string> = {
  publishWaitsForApp: "build_publish_waits_for_app",
  chatThreadFollowsBuild: "build_chat_thread_follows_build",
  recentRowsStable: "build_recent_rows_stable",
  mobileActions: "build_mobile_actions",
  chipsWrapMobile: "home_chips_wrap_mobile",
  publishOnRequest: "build_publish_on_request",
  figmaHandoff: "build_figma_handoff",
};

const SITE_FLAG_KEYS: Record<keyof typeof DEFAULT_SITE_FLAGS, string> = {
  siteNames: "build_site_own_name",
  siteRepoChip: "build_site_keeps_own_repo",
  siteListDetails: "build_site_list_details",
};

const FRAMING_READS: Array<[string, () => Promise<boolean>]> = [
  ["build_website_framing", readWebsiteFraming],
  ["build_idea_examples", readIdeaExamples],
  ["build_idea_attach", readIdeaAttach],
  ["build_chat_toast_named", readChatToastNamed],
  ["build_nav_opens_site_list", readSiteListFirst],
  ["home_build_website_cta", readHomeBuildCta],
  ["cookie_banner_clear_of_composer", readCookieClearOfComposer],
];

describe("the web's fallback for every build switch is that switch's registry default", () => {
  beforeEach(() => {
    resetWebsiteFramingForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("every build-sessions ui flag has a registry key, and its fallback equals that key's default", () => {
    expect(Object.keys(DEFAULT_UI_FLAGS).sort()).toEqual(Object.keys(UI_FLAG_KEYS).sort());
    for (const [flag, key] of Object.entries(UI_FLAG_KEYS)) {
      expect(DEFAULT_UI_FLAGS[flag as keyof typeof DEFAULT_UI_FLAGS], `${flag} vs ${key}`).toBe(registryDefault(key));
    }
    expect(registryDefault("build_publish_on_request")).toBe(true);
    expect(DEFAULT_UI_FLAGS.publishOnRequest).toBe(true);
  });

  it("every build-sessions site flag has a registry key, and its fallback equals that key's default", () => {
    expect(Object.keys(DEFAULT_SITE_FLAGS).sort()).toEqual(Object.keys(SITE_FLAG_KEYS).sort());
    for (const [flag, key] of Object.entries(SITE_FLAG_KEYS)) {
      expect(DEFAULT_SITE_FLAGS[flag as keyof typeof DEFAULT_SITE_FLAGS], `${flag} vs ${key}`).toBe(registryDefault(key));
    }
  });

  it("a sessions answer from a backend that sends no flags at all reads as every default, and one that sends them wins", () => {
    expect(readUiFlags(undefined)).toEqual(DEFAULT_UI_FLAGS);
    expect(readUiFlags(null)).toEqual(DEFAULT_UI_FLAGS);
    expect(readUiFlags({})).toEqual(DEFAULT_UI_FLAGS);
    expect(readSiteFlags(undefined)).toEqual(DEFAULT_SITE_FLAGS);
    const allOff = {
      publish_waits_for_app: false,
      chat_thread_follows_build: false,
      recent_rows_stable: false,
      mobile_actions: false,
      chips_wrap_mobile: false,
      publish_on_request: false,
      figma_handoff: false,
    };
    expect(Object.values(readUiFlags(allOff)).every((v) => v === false)).toBe(true);
    expect(Object.values(readSiteFlags({ site_names: false, site_repo_chip: false, site_list_details: false })).every((v) => v === false)).toBe(true);
  });

  it("a failed build-framing read answers each switch's registry default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    for (const [key, read] of FRAMING_READS) {
      resetWebsiteFramingForTests();
      expect(await read(), key).toBe(registryDefault(key));
    }
  });

  it("the switch this change adds ships on", () => {
    expect(registryDefault("build_flags_fail_to_default")).toBe(true);
  });
});
