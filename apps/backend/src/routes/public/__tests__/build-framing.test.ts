import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  failing: [] as string[],
  keys: [] as string[],
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string) => {
    H.keys.push(key);
    if (H.failing.includes(key)) throw new Error("db down");
    return H.values[key] === undefined ? true : H.values[key] === true;
  }),
}));

import { publicBuildFraming } from "../build-framing";
import { APP_SETTINGS } from "@/services/settings/registry";

function makeRes() {
  return {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe("GET /api/public/build-framing", () => {
  beforeEach(() => {
    H.values = {};
    H.failing = [];
    H.keys = [];
  });

  it.each(["build_website_framing", "build_idea_examples", "build_chat_toast_named", "build_nav_opens_site_list", "build_idea_attach", "home_build_website_cta", "cookie_banner_clear_of_composer", "build_flags_fail_to_default"] as const)(
    "%s is a global key that ships on",
    (key) => {
      const def = APP_SETTINGS[key];
      expect(def.type).toBe("boolean");
      expect(def.scope).toBe("global");
      expect(def.defaultValue).toBe(true);
    },
  );

  it("says both are on by default, reading only their own keys", async () => {
    const res = makeRes();
    await publicBuildFraming({} as never, res as never);
    expect(res.body).toEqual({ website_framing: true, idea_examples: true, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });
    expect([...H.keys].sort()).toEqual([
      "build_chat_toast_named",
      "build_flags_fail_to_default",
      "build_idea_attach",
      "build_idea_examples",
      "build_nav_opens_site_list",
      "build_website_framing",
      "cookie_banner_clear_of_composer",
      "home_build_website_cta",
    ]);
  });

  it("turns each off on its own key only", async () => {
    H.values = { build_idea_examples: false };
    const off = makeRes();
    await publicBuildFraming({} as never, off as never);
    expect(off.body).toEqual({ website_framing: true, idea_examples: false, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });

    H.values = { build_website_framing: false };
    const framingOff = makeRes();
    await publicBuildFraming({} as never, framingOff as never);
    expect(framingOff.body).toEqual({ website_framing: false, idea_examples: true, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });

    H.values = { build_chat_toast_named: false, site_list_first: true, idea_attach: true };
    const toastOff = makeRes();
    await publicBuildFraming({} as never, toastOff as never);
    expect(toastOff.body).toEqual({ website_framing: true, idea_examples: true, chat_toast_named: false, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });

    H.values = { build_nav_opens_site_list: false };
    const listOff = makeRes();
    await publicBuildFraming({} as never, listOff as never);
    expect(listOff.body).toEqual({ website_framing: true, idea_examples: true, chat_toast_named: true, site_list_first: false, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });
  });

  it("a failed read of one key falls back to that key's registry default, never off, and keeps the others", async () => {
    H.failing = ["build_idea_examples"];
    const res = makeRes();
    await publicBuildFraming({} as never, res as never);
    expect(res.body).toEqual({ website_framing: true, idea_examples: true, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });

    H.values = { build_website_framing: false };
    H.failing = ["build_chat_toast_named", "home_build_website_cta", "cookie_banner_clear_of_composer"];
    const mixed = makeRes();
    await publicBuildFraming({} as never, mixed as never);
    expect(mixed.body).toEqual({ website_framing: false, idea_examples: true, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });
  });

  it("every key failing at once still answers each key's registry default", async () => {
    H.failing = [
      "build_website_framing",
      "build_idea_examples",
      "build_chat_toast_named",
      "build_nav_opens_site_list",
      "build_idea_attach",
      "home_build_website_cta",
      "cookie_banner_clear_of_composer",
      "build_flags_fail_to_default",
    ];
    const res = makeRes();
    await publicBuildFraming({} as never, res as never);
    expect(res.body).toEqual({
      website_framing: APP_SETTINGS.build_website_framing.defaultValue,
      idea_examples: APP_SETTINGS.build_idea_examples.defaultValue,
      chat_toast_named: APP_SETTINGS.build_chat_toast_named.defaultValue,
      site_list_first: APP_SETTINGS.build_nav_opens_site_list.defaultValue,
      idea_attach: APP_SETTINGS.build_idea_attach.defaultValue,
      home_build_cta: APP_SETTINGS.home_build_website_cta.defaultValue,
      cookie_clear_of_composer: APP_SETTINGS.cookie_banner_clear_of_composer.defaultValue,
      fail_to_default: APP_SETTINGS.build_flags_fail_to_default.defaultValue,
    });
    expect(Object.values(res.body as Record<string, boolean>).every((v) => v === true)).toBe(true);
  });

  it("with build_flags_fail_to_default off, a failed read says off for that key only, as before", async () => {
    H.values = { build_flags_fail_to_default: false };
    H.failing = ["build_idea_examples", "cookie_banner_clear_of_composer"];
    const res = makeRes();
    await publicBuildFraming({} as never, res as never);
    expect(res.body).toEqual({ website_framing: true, idea_examples: false, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: false, fail_to_default: false });
  });

  it("B15 and B27: the home build button and the composer-clear cookie banner each turn off on their own key, and a failed read keeps them on", async () => {
    H.values = { home_build_website_cta: false };
    const ctaOff = makeRes();
    await publicBuildFraming({} as never, ctaOff as never);
    expect(ctaOff.body).toMatchObject({ home_build_cta: false, cookie_clear_of_composer: true, website_framing: true });

    H.values = { cookie_banner_clear_of_composer: false };
    const cookieOff = makeRes();
    await publicBuildFraming({} as never, cookieOff as never);
    expect(cookieOff.body).toMatchObject({ home_build_cta: true, cookie_clear_of_composer: false, website_framing: true });

    H.values = {};
    H.failing = ["home_build_website_cta", "cookie_banner_clear_of_composer"];
    const failed = makeRes();
    await publicBuildFraming({} as never, failed as never);
    expect(failed.body).toEqual({ website_framing: true, idea_examples: true, chat_toast_named: true, site_list_first: true, idea_attach: true, home_build_cta: true, cookie_clear_of_composer: true, fail_to_default: true });
  });
});

describe("fail-to-default never opens a safety switch", () => {
  const SAFETY = /(product_builder|tier_gate|kill|pause|halt|cap|spend|budget|enforced|captcha|disabled)/;

  it("only the seven copy / layout keys may fall to their default, and none is safety-shaped", async () => {
    const { FAIL_TO_DEFAULT_UI_KEYS } = await import("../build-framing");
    expect([...FAIL_TO_DEFAULT_UI_KEYS].sort()).toEqual([
      "build_chat_toast_named",
      "build_idea_attach",
      "build_idea_examples",
      "build_nav_opens_site_list",
      "build_website_framing",
      "cookie_banner_clear_of_composer",
      "home_build_website_cta",
    ]);
    for (const key of FAIL_TO_DEFAULT_UI_KEYS) expect(key).not.toMatch(SAFETY);
  });

  it("with every read failing, the route reads no other key (a safety switch is never touched here)", async () => {
    H.failing = [
      "build_flags_fail_to_default",
      "build_website_framing",
      "build_idea_examples",
      "build_chat_toast_named",
      "build_nav_opens_site_list",
      "build_idea_attach",
      "home_build_website_cta",
      "cookie_banner_clear_of_composer",
    ];
    const res = makeRes();
    await publicBuildFraming({} as never, res as never);
    expect(new Set(H.keys)).toEqual(new Set(H.failing));
    for (const key of H.keys) expect(key === "build_flags_fail_to_default" || !SAFETY.test(key)).toBe(true);
  });
});
