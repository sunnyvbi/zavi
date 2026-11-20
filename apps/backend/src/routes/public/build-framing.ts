import type { Request, Response } from "express";
import { getBoolSetting } from "@/services/settings";
import { APP_SETTINGS } from "@/services/settings/registry";

export const FAIL_TO_DEFAULT_UI_KEYS = [
  "build_website_framing",
  "build_idea_examples",
  "build_chat_toast_named",
  "build_nav_opens_site_list",
  "build_idea_attach",
  "home_build_website_cta",
  "cookie_banner_clear_of_composer",
] as const;

type UiKey = (typeof FAIL_TO_DEFAULT_UI_KEYS)[number];

function readFlag(key: UiKey, failToDefault: boolean): Promise<boolean> {
  return getBoolSetting(key).catch(() => failToDefault && APP_SETTINGS[key].defaultValue === true);
}

export async function publicBuildFraming(_req: Request, res: Response): Promise<void> {
  const failToDefault = await getBoolSetting("build_flags_fail_to_default").catch(() => true);
  const [websiteFraming, ideaExamples, chatToastNamed, siteListFirst, ideaAttach, homeBuildCta, cookieClearOfComposer] = await Promise.all(
    FAIL_TO_DEFAULT_UI_KEYS.map((key) => readFlag(key, failToDefault)),
  );
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    website_framing: websiteFraming,
    idea_examples: ideaExamples,
    chat_toast_named: chatToastNamed,
    site_list_first: siteListFirst,
    idea_attach: ideaAttach,
    home_build_cta: homeBuildCta,
    cookie_clear_of_composer: cookieClearOfComposer,
    fail_to_default: failToDefault,
  });
}
