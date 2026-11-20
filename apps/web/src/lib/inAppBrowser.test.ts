import { describe, expect, it } from "vitest";

import { detectInAppBrowser, externalBrowserLink, handoffEnabled, handoffPage, handoffTarget, withoutAuthErrors } from "./inAppBrowser";

describe("withoutAuthErrors", () => {
  it("drops the provider's error fields and keeps everything else", () => {
    expect(
      withoutAuthErrors("https://www.zaviagent.com/creators/apply?invite=abc&error=server_error&error_code=bad_oauth&error_description=Unable+to+exchange"),
    ).toBe("https://www.zaviagent.com/creators/apply?invite=abc");
  });

  it("leaves a clean or unparseable address alone", () => {
    expect(withoutAuthErrors("https://www.zaviagent.com/login?signup=1")).toBe("https://www.zaviagent.com/login?signup=1");
    expect(withoutAuthErrors("not a url")).toBe("not a url");
  });
});

const X_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.48";
const X_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 TwitterAndroid";
const FACEBOOK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/473.0.0.35.109;FBBV/612245432;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]";
const FACEBOOK_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/472.0.0.43.85;]";
const INSTAGRAM_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 341.0.3.24.105 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 627400398)";
const LINKEDIN_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1234";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36";
const IOS_WEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_WEBVIEW = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const TIKTOK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US WKWebView/1";
const TIKTOK_IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 musical_ly_41.9.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US WKWebView/1";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/127.0.6533.107 Mobile/15E148 Safari/604.1";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

describe("detectInAppBrowser", () => {
  it.each([
    ["X on iPhone", X_IPHONE, "X"],
    ["X on Android", X_ANDROID, "X"],
    ["Facebook on iPhone", FACEBOOK_IOS, "Facebook"],
    ["Facebook on Android", FACEBOOK_ANDROID, "Facebook"],
    ["Instagram on iPhone", INSTAGRAM_IOS, "Instagram"],
    ["LinkedIn on iPhone", LINKEDIN_IOS, "LinkedIn"],
    ["an unnamed Android webview", ANDROID_WEBVIEW, null],
    ["an unnamed iPhone webview", IOS_WEBVIEW, null],
    ["an unnamed iPad webview", IPAD_WEBVIEW, null],
    ["TikTok on iPhone", TIKTOK_IOS, "TikTok"],
    ["TikTok on iPhone, newer build with Safari/", TIKTOK_IOS_SAFARI, "TikTok"],
  ])("flags %s", (_name, ua, app) => {
    expect(detectInAppBrowser(ua)).toEqual({ app });
  });

  it.each([
    ["Safari on iPhone", SAFARI_IPHONE],
    ["Safari on iPad", SAFARI_IPAD],
    ["Chrome on Android", CHROME_ANDROID],
    ["Chrome on iPhone", CHROME_IOS],
    ["Firefox on iPhone", FIREFOX_IOS],
    ["Chrome on a Mac", CHROME_MAC],
    ["Firefox on Windows", FIREFOX_WINDOWS],
    ["no user agent", ""],
  ])("leaves %s alone", (_name, ua) => {
    expect(detectInAppBrowser(ua)).toBeNull();
  });
});

const X_IPHONE_PROD =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24A446 Twitter for iPhone/12.33";
const PAGE = "https://www.zaviagent.com/login?signup=1&next=%2Fonboarding%2Fpast-work%3Fwebsite%3Dacme.com";

describe("externalBrowserLink", () => {
  it.each([
    ["X on iPhone (seen in prod)", X_IPHONE_PROD],
    ["X on iPhone", X_IPHONE],
    ["Instagram on iPhone", INSTAGRAM_IOS],
    ["LinkedIn on iPhone", LINKEDIN_IOS],
    ["an unnamed iPhone webview", IOS_WEBVIEW],
  ])("sends %s to Safari with the whole page address", (_name, ua) => {
    expect(externalBrowserLink(PAGE, ua)).toEqual({
      href: "x-safari-https://www.zaviagent.com/login?signup=1&next=%2Fonboarding%2Fpast-work%3Fwebsite%3Dacme.com",
      label: "Open in Safari",
    });
  });

  it.each([
    ["X on Android", X_ANDROID],
    ["Facebook on Android", FACEBOOK_ANDROID],
    ["an unnamed Android webview", ANDROID_WEBVIEW],
  ])("sends %s to Chrome, falling back to the same page", (_name, ua) => {
    const link = externalBrowserLink(PAGE, ua);
    expect(link?.label).toBe("Open in Chrome");
    expect(link?.href).toBe(
      "intent://www.zaviagent.com/login?signup=1&next=%2Fonboarding%2Fpast-work%3Fwebsite%3Dacme.com" +
        "#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" +
        encodeURIComponent(PAGE) +
        ";end",
    );
  });

  it.each([
    ["Safari on iPhone", SAFARI_IPHONE],
    ["Chrome on Android", CHROME_ANDROID],
    ["Chrome on iPhone", CHROME_IOS],
    ["Firefox on iPhone", FIREFOX_IOS],
    ["Chrome on a Mac", CHROME_MAC],
    ["no user agent", ""],
  ])("offers nothing in %s, which can already sign in with Google", (_name, ua) => {
    expect(externalBrowserLink(PAGE, ua)).toBeNull();
  });

  it("sends the X app on an iPad that reports itself as a Mac to Safari", () => {
    const ipadAsMac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Twitter for iPad/12.33";
    expect(externalBrowserLink(PAGE, ipadAsMac)?.label).toBe("Open in Safari");
  });

  it("refuses anything that is not an https page", () => {
    expect(externalBrowserLink("http://localhost:3010/login", X_IPHONE)).toBeNull();
    expect(externalBrowserLink("javascript:alert(1)", X_IPHONE)).toBeNull();
    expect(externalBrowserLink("not a url", X_ANDROID)).toBeNull();
  });
});

describe("handoffTarget", () => {
  const POST_LINK = "https://www.zaviagent.com/?from=cr-z";

  it("stays off for every visitor until it is switched on", () => {
    expect(handoffTarget(POST_LINK, X_IPHONE, false)).toBeNull();
    expect(handoffTarget(POST_LINK, X_ANDROID, false)).toBeNull();
  });

  it("lets one private test link through while it is off for everyone else", () => {
    const link = handoffTarget("https://www.zaviagent.com/?from=cr-z&iab_handoff=1", X_IPHONE, false);
    expect(link?.href).toBe("x-safari-https://www.zaviagent.com/?from=cr-z&iab=x&utm_source=x");
    expect(handoffTarget("https://www.zaviagent.com/?from=cr-z&iab_handoff=0", X_IPHONE, false)).toBeNull();
  });

  it("sends an iPhone in the X app to Safari with the post's channel tag and a source", () => {
    expect(handoffTarget(POST_LINK, X_IPHONE, true)).toEqual({
      href: "x-safari-https://www.zaviagent.com/?from=cr-z&iab=x&utm_source=x",
      label: "Open in Safari",
    });
  });

  it("sends Android in the X app to Chrome and marks the fallback page so it cannot loop", () => {
    const link = handoffTarget(POST_LINK, X_ANDROID, true);
    const marked = "https://www.zaviagent.com/?from=cr-z&iab=x&utm_source=x";
    expect(link?.href).toBe(
      `intent://www.zaviagent.com/?from=cr-z&iab=x&utm_source=x#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(marked)};end`,
    );
    expect(handoffTarget(marked, X_ANDROID, true)).toBeNull();
    expect(handoffTarget(marked, X_IPHONE, true)).toBeNull();
  });

  it("keeps a campaign source the link already carries", () => {
    expect(handoffTarget("https://www.zaviagent.com/pricing?utm_source=x_ads&utm_campaign=nov", X_IPHONE, true)?.href).toBe(
      "x-safari-https://www.zaviagent.com/pricing?utm_source=x_ads&utm_campaign=nov&iab=x",
    );
  });

  it("leaves every other app and every real browser where it is", () => {
    for (const ua of [
      INSTAGRAM_IOS,
      FACEBOOK_IOS,
      FACEBOOK_ANDROID,
      LINKEDIN_IOS,
      TIKTOK_IOS,
      ANDROID_WEBVIEW,
      IOS_WEBVIEW,
      SAFARI_IPHONE,
      SAFARI_IPAD,
      FIREFOX_IOS,
      "",
      null,
    ]) {
      expect(handoffTarget(POST_LINK, ua, true)).toBeNull();
    }
  });

  it("never moves a page that carries a sign-in secret or sits behind sign-in", () => {
    for (const page of [
      "https://www.zaviagent.com/auth/callback?code=abc",
      "https://www.zaviagent.com/reset-password/abc",
      "https://www.zaviagent.com/login?signup=1",
      "https://www.zaviagent.com/workspace",
      "https://www.zaviagent.com/workspace/chat/1",
      "https://www.zaviagent.com/start",
      "https://www.zaviagent.com/onboarding",
      "https://www.zaviagent.com/invite/abc",
      "https://www.zaviagent.com/oauth/authorize",
      "https://www.zaviagent.com/connectors/composio/done",
      "https://www.zaviagent.com/?code=abc",
      "https://www.zaviagent.com/?token=abc",
      "https://www.zaviagent.com/?key=abc",
      "https://www.zaviagent.com/?error=server_error",
      "https://www.zaviagent.com/?token_hash=abc&type=magiclink",
      "https://www.zaviagent.com/pricing?token_hash=abc&type=recovery",
      "https://www.zaviagent.com/#access_token=abc&refresh_token=def",
      "https://www.zaviagent.com/approvals",
      "https://www.zaviagent.com/applications?from=cr-z",
    ]) {
      expect(handoffTarget(page, X_IPHONE, true)).toBeNull();
      expect(handoffTarget(page, X_ANDROID, true)).toBeNull();
    }
  });

  it("still moves public pages whose names only start like a guarded one", () => {
    expect(handoffTarget("https://www.zaviagent.com/startups", X_IPHONE, true)?.href).toBe(
      "x-safari-https://www.zaviagent.com/startups?iab=x&utm_source=x",
    );
    expect(handoffTarget("https://www.zaviagent.com/creators/apply?invite=abc", X_IPHONE, true)?.href).toBe(
      "x-safari-https://www.zaviagent.com/creators/apply?invite=abc&iab=x&utm_source=x",
    );
  });

  it("skips iPhones and iPads too old to open Safari from a link, or whose version is unknown", () => {
    const old = X_IPHONE.replace("iPhone OS 17_5", "iPhone OS 16_7");
    const ipadAsMac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPad/10.48";
    expect(handoffTarget(POST_LINK, old, true)).toBeNull();
    expect(handoffTarget(POST_LINK, ipadAsMac, true)).toBeNull();
    expect(handoffTarget(POST_LINK, X_IPHONE.replace("iPhone OS 17_5", "iPhone OS 18_1"), true)?.label).toBe("Open in Safari");
  });

  it("does nothing on a page that is not https or not a URL", () => {
    expect(handoffTarget("http://localhost:3000/?from=cr-z", X_IPHONE, true)).toBeNull();
    expect(handoffTarget("not a url", X_IPHONE, true)).toBeNull();
  });
});

describe("handoffEnabled", () => {
  it("is on unless the setting clearly says off", () => {
    for (const on of [undefined, null, "", "on", "ON", "yes", "true", "1", "anything"]) expect(handoffEnabled(on)).toBe(true);
    for (const off of ["off", "OFF", " Off ", "no", "No", "false", "FALSE", "0"]) expect(handoffEnabled(off)).toBe(false);
  });
});

describe("handoffPage", () => {
  it("uses the address the visitor landed on while they are still on that page", () => {
    expect(handoffPage("https://www.zaviagent.com/?via=abcdefgh", "https://www.zaviagent.com/")).toBe("https://www.zaviagent.com/?via=abcdefgh");
  });

  it("uses the current address once the visitor has moved to another page", () => {
    expect(handoffPage("https://www.zaviagent.com/?via=abcdefgh", "https://www.zaviagent.com/pricing")).toBe("https://www.zaviagent.com/pricing");
    expect(handoffPage(null, "https://www.zaviagent.com/pricing")).toBe("https://www.zaviagent.com/pricing");
    expect(handoffPage("not a url", "https://www.zaviagent.com/pricing")).toBe("https://www.zaviagent.com/pricing");
  });
});
