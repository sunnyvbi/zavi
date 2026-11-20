
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { isPublicPath, isCreatorGatedPath, rewriteAgentsToWorkspace, rewriteLegacyToWorkspace } from "@/lib/middlewareRoutes";
import { SHOPIFY_APP_HOME_PATH, shopifyFrameAncestors } from "@/lib/shopify-app-home/frameAncestors";
import { SHOPIFY_APP_HOME_REQUEST_HEADER } from "@/lib/shopify-app-home/config";
import { hasAuthCookie, withTimeout } from "@/lib/middlewareAuth";
import { WEBSITE_PAST_WORK_ROUTE } from "@/lib/onboardingRoutes";
import { copyAuthCookies } from "@/lib/auth-cookies";
import { fetchWithTimeout, WEB_SERVER_DB_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { isTransientAuthError } from "@/lib/authTransient";
import { isCreatorPath, oauthConsentNext, plainNext } from "@/lib/safe-next";
import { onboardingAttributionHref, urlAttribution, withUrlAttribution } from "@/lib/marketing/liveFrom";
import { WWW_ORIGIN, isRetiredSegmentHost } from "@/lib/marketing/retiredSubdomains";
import { isUnpublishedSiteHost, unpublishedSiteResponse } from "@/lib/marketing/unpublishedSiteHost";
import { isUnknownSiteHost, siteNotFoundResponse } from "@/lib/siteHosts";
import { COUNTRY_COOKIE, REGION_COOKIE, REGION_COOKIE_MAX_AGE_SECONDS, countryCode, regionForCountry } from "@/lib/region";

const MW_DB_TIMEOUT_MS = 2500;

const MW_AUTH_TIMEOUT_MS = 6000;

export function withRegionCookie(req: NextRequest, res: NextResponse): NextResponse {
  const viewerCountry = req.headers.get("cloudfront-viewer-country");
  const country = countryCode(viewerCountry);
  if (!country && req.cookies.get(COUNTRY_COOKIE) !== undefined) {
    res.cookies.set(COUNTRY_COOKIE, "", { path: "/", maxAge: 0 });
  } else if (country && req.cookies.get(COUNTRY_COOKIE)?.value !== country) {
    res.cookies.set(COUNTRY_COOKIE, country, {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: REGION_COOKIE_MAX_AGE_SECONDS,
    });
  }
  const region = regionForCountry(viewerCountry);
  const current = req.cookies.get(REGION_COOKIE)?.value;
  if (!region) {
    if (current !== undefined) res.cookies.set(REGION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }
  if (current !== region) {
    res.cookies.set(REGION_COOKIE, region, {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: REGION_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return res;
}

export const HOST_CHECK_ONLY_PATH =
  /^\/(?:robots\.txt|sitemap\.xml|llms\.txt|pricing\.md|manifest\.webmanifest|icon\.svg|favicon\.ico|apple-app-site-association|zavi-editor-runtime\.js|\.well-known\/.*|opengraph-image.*|mascots\/video\/.*)$/;

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (isUnknownSiteHost(req.headers.get("x-forwarded-host") ?? req.headers.get("host"))) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return isUnpublishedSiteHost(host) ? unpublishedSiteResponse(req.method) : siteNotFoundResponse(req.method);
  }
  if (HOST_CHECK_ONLY_PATH.test(req.nextUrl.pathname)) return NextResponse.next();
  const res = noStoreIfSettingCookies(withRegionCookie(req, await route(req)));
  if (req.nextUrl.pathname === SHOPIFY_APP_HOME_PATH) {
    res.headers.set("Content-Security-Policy", shopifyFrameAncestors());
    res.headers.set("X-Robots-Tag", "noindex");
  }
  return res;
}

export function noStoreIfSettingCookies(res: NextResponse): NextResponse {
  if (res.cookies.getAll().length === 0) return res;
  res.headers.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
  res.headers.set("CDN-Cache-Control", "no-store");
  res.headers.set("Expires", "0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

async function route(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const { search } = req.nextUrl;

  const rawHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (isRetiredSegmentHost(rawHost)) {
    const dest = new URL(WWW_ORIGIN);
    dest.pathname = pathname;
    dest.search = search;
    return NextResponse.redirect(dest, 301);
  }

  const redirect =
    rewriteAgentsToWorkspace(req) ?? rewriteLegacyToWorkspace(req);
  if (redirect) return redirect;

  const reqHeaders = new Headers(req.headers);
  reqHeaders.set(SHOPIFY_APP_HOME_REQUEST_HEADER, pathname === SHOPIFY_APP_HOME_PATH ? "1" : "0");

  let res = NextResponse.next({ request: { headers: reqHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: fetchWithTimeout(WEB_SERVER_DB_TIMEOUT_MS) },
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options: CookieOptions;
          }[],
          cacheHeaders?: Record<string, string>,
        ) {
          for (const { name, value, options } of cookiesToSet) {
            req.cookies.set({ name, value, ...options });
          }
          res = NextResponse.next({ request: { headers: reqHeaders } });
          for (const { name, value, options } of cookiesToSet) {
            res.cookies.set({ name, value, ...options });
          }
          for (const [k, v] of Object.entries(cacheHeaders ?? {})) res.headers.set(k, v);
        },
      },
    },
  );

  const userRes = await withTimeout(
    supabase.auth.getUser(),
    MW_AUTH_TIMEOUT_MS,
  );
  const user = userRes.ok ? userRes.value.data.user : null;
  const authUnknown =
    (!userRes.ok && userRes.reason === "timeout") ||
    (userRes.ok && !user && isTransientAuthError(userRes.value.error));

  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/staff") ||
    pathname === "/loginas"
  ) {
    return res;
  }

  if (pathname === "/signup") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("signup", "1");
    const attribution = urlAttribution(url.searchParams);
    if (Object.keys(attribution).length) {
      const next = plainNext(url.searchParams.get("next")) ?? "/start";
      url.searchParams.set("next", onboardingAttributionHref(next, attribution));
    }
    return copyAuthCookies(NextResponse.redirect(url), res);
  }

  if (!user) {
    if (authUnknown && hasAuthCookie(req)) {
      return res;
    }

    if (!isPublicPath(pathname)) {
      const url = req.nextUrl.clone();
      const returnTo = pathname + req.nextUrl.search;
      url.pathname = "/login";
      url.search = `?next=${encodeURIComponent(returnTo)}`;
      return copyAuthCookies(NextResponse.redirect(url), res);
    }
    return res;
  }

  const profRes = await withTimeout(
    supabase
      .from("profiles")
      .select("active_tenant_id, beta_invited_at")
      .eq("user_id", user.id)
      .maybeSingle(),
    MW_DB_TIMEOUT_MS,
  );
  const onboarded = profRes.ok
    ? !!profRes.value.data?.active_tenant_id
    : false;
  const betaGranted = profRes.ok
    ? !!profRes.value.data?.beta_invited_at
    : true;

  if (onboarded) {
    if (pathname === "/login" || pathname === "/") {
      const asked = pathname === "/login" ? (plainNext(req.nextUrl.searchParams.get("next")) ?? "/workspace") : "/workspace";
      const next = isCreatorPath(asked) ? "/workspace" : asked;
      return copyAuthCookies(NextResponse.redirect(new URL(next, req.url)), res);
    }
    return res;
  }

  if (
    !onboarded &&
    !betaGranted &&
    process.env.CLOSED_BETA_ENABLED === "true"
  ) {
    const allowed =
      pathname === "/talk-to-team" ||
      pathname.startsWith("/invite/") ||
      pathname.startsWith("/auth/") ||
      isCreatorGatedPath(pathname) ||
      isPublicPath(pathname);
    if (!allowed) {
      const url = req.nextUrl.clone();
      url.pathname = "/talk-to-team";
      url.search = "";
      return copyAuthCookies(NextResponse.redirect(url), res);
    }
    return res;
  }

  if (!isPublicPath(pathname) && !isCreatorGatedPath(pathname) && pathname !== WEBSITE_PAST_WORK_ROUTE) {
    const url = req.nextUrl.clone();
    url.pathname = "/start";
    const consent = oauthConsentNext(pathname + req.nextUrl.search);
    const start = withUrlAttribution(
      consent ? `/start?next=${encodeURIComponent(consent)}` : "/start",
      urlAttribution(req.nextUrl.searchParams),
    );
    url.search = new URL(start, req.url).search;
    return copyAuthCookies(NextResponse.redirect(url), res);
  }
  return res;
}

export const config = {
  matcher: [
    "/(robots\\.txt|sitemap\\.xml|llms\\.txt|pricing\\.md|manifest\\.webmanifest|icon\\.svg|favicon\\.ico|apple-app-site-association|zavi-editor-runtime\\.js|\\.well-known/.*|opengraph-image.*|mascots/video/.*)",
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|apple-app-site-association|\\.well-known/|opengraph-image|icon.svg|manifest.webmanifest|llms.txt|pricing.md|zavi-editor-runtime\\.js|mascots/video/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp4)$).*)",
  ],
};
