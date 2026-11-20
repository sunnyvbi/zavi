import { describe, it, expect } from "vitest";
import {
  assertBrowserLeastPrivilege,
  BrowserLeastPrivilegeError,
} from "../least-privilege";

describe("assertBrowserLeastPrivilege", () => {
  it("no-ops when the run has no browser tools", () => {
    expect(() =>
      assertBrowserLeastPrivilege(["stripe_refund", "gmail_send"]),
    ).not.toThrow();
  });

  it("allows the current qa-engineer-weekly tool set (browser_* + QA helpers)", () => {
    expect(() =>
      assertBrowserLeastPrivilege([
        "qa_engineer__list_active_tests",
        "qa_engineer__record_test_outcome",
        "qa_engineer__get_runtime_config",
        "browser_nav",
        "browser_click",
        "browser_fill",
        "browser_text",
        "browser_assert_text",
        "browser_assert_url",
        "browser_screenshot",
        "browser_wait_for",
      ]),
    ).not.toThrow();
  });

  it("refuses browser_* mixed with a money tool", () => {
    expect(() =>
      assertBrowserLeastPrivilege(["browser_nav", "stripe_refund"]),
    ).toThrow(BrowserLeastPrivilegeError);
  });

  it("refuses browser_* mixed with a code/outbound tool", () => {
    expect(() =>
      assertBrowserLeastPrivilege(["browser_text", "github_merge_pr"]),
    ).toThrow(BrowserLeastPrivilegeError);
    expect(() =>
      assertBrowserLeastPrivilege(["browser_nav", "gmail_send"]),
    ).toThrow(BrowserLeastPrivilegeError);
    expect(() =>
      assertBrowserLeastPrivilege(["browser_nav", "tenant_ban_user"]),
    ).toThrow(BrowserLeastPrivilegeError);
  });

  it("allows the REAL browser-operator tool set (browser_* + read-only research tools)", () => {
    expect(() =>
      assertBrowserLeastPrivilege([
        "browser_nav",
        "browser_click",
        "browser_fill",
        "browser_text",
        "browser_assert_text",
        "browser_assert_url",
        "browser_screenshot",
        "browser_wait_for",
        "web_fetch__fetch",
        "web_search__search",
        "apify__rag_web_browser",
      ]),
    ).not.toThrow();
  });

  it("Gap 3: refuses an internal WRITE the name patterns MISS (stripe__create_payment)", () => {
    expect(() =>
      assertBrowserLeastPrivilege(["browser_nav", "stripe__create_payment"]),
    ).toThrow(BrowserLeastPrivilegeError);
  });

  it("Gap 3: refuses browser_* mixed with money/code/outbound server tools", () => {
    for (const t of [
      "github__open_pr",
      "email__send",
      "slack__post_message",
      "stripe__remit_to_tenant",
      "meta_ads__create_ad_set",
    ]) {
      expect(() => assertBrowserLeastPrivilege(["browser_text", t]), t).toThrow(
        BrowserLeastPrivilegeError,
      );
    }
  });

  it("Gap 3: does NOT over-block benign internal writes (memory/report/qa bookkeeping)", () => {
    for (const t of ["memory__write", "report__write", "qa_engineer__record_test_outcome", "growth__log"]) {
      expect(() => assertBrowserLeastPrivilege(["browser_text", t]), t).not.toThrow();
    }
  });

  it("surfaces the offending tools on the error", () => {
    try {
      assertBrowserLeastPrivilege([
        "browser_nav",
        "stripe_refund",
        "linear_create_issue",
      ]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserLeastPrivilegeError);
      expect((e as BrowserLeastPrivilegeError).offendingTools).toEqual([
        "stripe_refund",
        "linear_create_issue",
      ]);
    }
  });
});
