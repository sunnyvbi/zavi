import { describe, expect, it } from "vitest";
import { execCreatesProviderObjects } from "../../../../../workers/functions/dispatch-channel-action";
import {
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_BUDGET_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  LINKEDIN_RESUME_CLASS,
  LINKEDIN_SET_STATUS_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  LINKEDIN_TARGETING_CLASS,
} from "../../../tools/linkedin-ads/_change-bodies";

describe("execCreatesProviderObjects for LinkedIn card classes", () => {
  it.each([LINKEDIN_SWAP_AD_CLASS, LINKEDIN_CREATE_AD_CLASS, LINKEDIN_CREATE_CAMPAIGN_CLASS, LINKEDIN_DUPLICATE_CLASS])(
    "%s settles an interrupted run as outcome unknown, so a retry cannot add a second live ad",
    (execClass) => {
      expect(execCreatesProviderObjects(execClass)).toBe(true);
    },
  );

  it.each([
    LINKEDIN_RESUME_CLASS,
    LINKEDIN_BUDGET_CLASS,
    LINKEDIN_TARGETING_CLASS,
    LINKEDIN_SET_STATUS_CLASS,
    LINKEDIN_CAMPAIGN_EDIT_CLASS,
    LINKEDIN_GROUP_EDIT_CLASS,
    LINKEDIN_ARCHIVE_CLASS,
    LINKEDIN_AD_STATUS_CLASS,
  ])("%s stays retryable after an interruption", (execClass) => {
    expect(execCreatesProviderObjects(execClass)).toBe(false);
  });
});
