import { describe, expect, it } from "vitest";
import snapshot from "./catalog-slugs.snapshot.json";
import { isRawEmailSendAction } from "../providers";

const mailchimp: string[] = snapshot.mailchimp;
const klaviyo: string[] = snapshot.klaviyo;
const all = [...mailchimp, ...klaviyo];

const LEFT_ON_CARD = [
  "KLAVIYO_CREATE_CAMPAIGN_CLONE",
  "KLAVIYO_CREATE_TAG_RELATIONSHIPS_FLOWS",
  "KLAVIYO_CREATE_TEMPLATE_CLONE",
  "KLAVIYO_DELETE_FLOW",
  "KLAVIYO_DELETE_TAG_RELATIONSHIPS_FLOWS",
  "KLAVIYO_MERGE_PROFILES",
  "KLAVIYO_REMOVE_PROFILE_FROM_LIST",
  "KLAVIYO_REQUEST_PROFILE_DELETION",
  "KLAVIYO_SUPPRESS_PROFILES",
  "KLAVIYO_UNSUBSCRIBE_PROFILES",
  "KLAVIYO_UPDATE_CAMPAIGN_SEND_JOB",
  "MAILCHIMP_ADD_AUTOMATION",
  "MAILCHIMP_ADD_MEMBER_NOTE",
  "MAILCHIMP_ARCHIVE_AUTOMATION",
  "MAILCHIMP_ARCHIVE_LIST_MEMBER",
  "MAILCHIMP_DELETE_LIST_MEMBER",
  "MAILCHIMP_PAUSE_AUTOMATION_EMAILS",
  "MAILCHIMP_REMOVE_LIST_MEMBER_FROM_SEGMENT",
  "MAILCHIMP_REMOVE_SUBSCRIBER_FROM_WORKFLOW",
  "MAILCHIMP_REPLICATE_CAMPAIGN",
  "MAILCHIMP_UNSCHEDULE_CAMPAIGN",
];

describe("the raw-send rule over both catalogs", () => {
  it("the snapshot is the two whole catalogs, and every action carries its toolkit's prefix", () => {
    expect(mailchimp).toHaveLength(271);
    expect(klaviyo).toHaveLength(231);
    expect(mailchimp.every((s) => s.startsWith("MAILCHIMP_"))).toBe(true);
    expect(klaviyo.every((s) => s.startsWith("KLAVIYO_"))).toBe(true);
  });

  it("blocks exactly these actions", () => {
    expect(all.filter((s) => isRawEmailSendAction(s)).sort()).toEqual([
      "KLAVIYO_ADD_PROFILE_TO_LIST",
      "KLAVIYO_BULK_CREATE_CLIENT_EVENTS",
      "KLAVIYO_BULK_CREATE_EVENTS",
      "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB",
      "KLAVIYO_CREATE_CLIENT_EVENT",
      "KLAVIYO_CREATE_EVENT",
      "KLAVIYO_CREATE_OR_UPDATE_CLIENT_PROFILE",
      "KLAVIYO_CREATE_OR_UPDATE_PROFILE",
      "KLAVIYO_CREATE_PROFILE",
      "KLAVIYO_SPAWN_BULK_PROFILE_IMPORT_JOB",
      "KLAVIYO_SUBSCRIBE_PROFILES",
      "KLAVIYO_UNSUPPRESS_PROFILES",
      "KLAVIYO_UPDATE_CAMPAIGN",
      "KLAVIYO_UPDATE_FLOW_STATUS",
      "KLAVIYO_UPDATE_PROFILE",
      "MAILCHIMP_ADD_EVENT",
      "MAILCHIMP_ADD_MEMBER_TO_LIST",
      "MAILCHIMP_ADD_MEMBER_TO_SEGMENT",
      "MAILCHIMP_ADD_OR_REMOVE_MEMBER_TAGS",
      "MAILCHIMP_ADD_OR_UPDATE_LIST_MEMBER",
      "MAILCHIMP_ADD_SUBSCRIBER_TO_WORKFLOW_EMAIL",
      "MAILCHIMP_BATCH_ADD_OR_REMOVE_MEMBERS",
      "MAILCHIMP_BATCH_SUBSCRIBE_OR_UNSUBSCRIBE",
      "MAILCHIMP_CUSTOMER_JOURNEYS_API_TRIGGER_FOR_A_CONTACT",
      "MAILCHIMP_RESEND_CAMPAIGN",
      "MAILCHIMP_RESUME_RSS_CAMPAIGN",
      "MAILCHIMP_SCHEDULE_CAMPAIGN",
      "MAILCHIMP_SEND_CAMPAIGN",
      "MAILCHIMP_SEND_TEST_EMAIL",
      "MAILCHIMP_START_AUTOMATED_EMAIL",
      "MAILCHIMP_START_AUTOMATION_EMAILS",
      "MAILCHIMP_START_BATCH_OPERATION",
      "MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS",
      "MAILCHIMP_UPDATE_LIST_MEMBER",
      "MAILCHIMP_UPDATE_WORKFLOW_EMAIL",
    ]);
  });

  it("every other write whose name looks like sending, subscribing or an event was looked at, and is left on the normal approval card", () => {
    const shaped = /(^|_)(SEND|RESEND|SCHEDULE|UNSCHEDULE|START|RESUME|TRIGGER|REPLICATE|CLONE|EVENT|EVENTS|AUTOMATION|FLOW|FLOWS|SUBSCRIBE|SUBSCRIBER|MEMBER|MEMBERS|PROFILE|PROFILES)(_|$)/;
    const read = /^[A-Z]+_(GET|LIST|SEARCH|RETRIEVE|QUERY)_/;
    expect(all.filter((s) => shaped.test(s) && !read.test(s) && !isRawEmailSendAction(s)).sort()).toEqual(LEFT_ON_CARD);
  });

  it("case does not matter", () => {
    expect(isRawEmailSendAction("mailchimp_send_campaign")).toBe(true);
    expect(isRawEmailSendAction(" Klaviyo_Create_Campaign_Send_Job ")).toBe(true);
  });

  it("campaign updates that can move a send or change its audience are blocked; content and folder edits are not", () => {
    for (const s of ["MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS", "KLAVIYO_UPDATE_CAMPAIGN", "MAILCHIMP_UPDATE_WORKFLOW_EMAIL"]) expect(isRawEmailSendAction(s), s).toBe(true);
    expect(isRawEmailSendAction("UPDATE_CAMPAIGN", "klaviyo")).toBe(true);
    for (const s of ["KLAVIYO_UPDATE_CAMPAIGN_MESSAGE", "KLAVIYO_UPDATE_CAMPAIGN_SEND_JOB", "MAILCHIMP_UPDATE_CAMPAIGN_FOLDER", "MAILCHIMP_UPDATE_CAMPAIGN_FEEDBACK_MESSAGE"]) expect(isRawEmailSendAction(s), s).toBe(false);
  });

  it("an action that does not start with its toolkit's name is caught once the catalog names the toolkit", () => {
    expect(isRawEmailSendAction("SEND_CAMPAIGN")).toBe(false);
    expect(isRawEmailSendAction("SEND_CAMPAIGN", "mailchimp")).toBe(true);
    expect(isRawEmailSendAction("CREATE_CAMPAIGN_SEND_JOB", "Klaviyo")).toBe(true);
  });

  it("another app's send is not this rule's business", () => {
    expect(isRawEmailSendAction("GMAIL_SEND_EMAIL")).toBe(false);
    expect(isRawEmailSendAction("HUBSPOT_SEND_CAMPAIGN")).toBe(false);
    expect(isRawEmailSendAction("MAILCHIMP_SEND_CAMPAIGN", "hubspot")).toBe(false);
  });

  it("list reads, list deletes and campaign drafting are not blocked", () => {
    for (const s of ["MAILCHIMP_GET_LISTS_INFO", "MAILCHIMP_DELETE_LIST", "MAILCHIMP_LIST_MEMBERS_INFO", "KLAVIYO_GET_LIST_PROFILES", "MAILCHIMP_ADD_CAMPAIGN", "MAILCHIMP_SET_CAMPAIGN_CONTENT", "KLAVIYO_CREATE_CAMPAIGN", "KLAVIYO_GET_CAMPAIGN_SEND_JOB"]) {
      expect(isRawEmailSendAction(s), s).toBe(false);
    }
  });
});
