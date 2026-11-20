
export type CookieRow = {
  name: string;
  provider: string;
  type: "Cookie" | "Local storage" | "Session storage" | "Cookie / storage";
  expiry: string;
  purpose: string;
  pattern: RegExp;
};

export const NECESSARY: CookieRow[] = [
  {
    name: "sb-<project>-auth-token (and .0, .1 chunks)",
    provider: "Zavi / Supabase Auth",
    type: "Cookie",
    expiry: "Session, refreshed while you use Zavi",
    purpose: "Keeps you signed in.",
    pattern: /^sb-/,
  },
  {
    name: "sb-<project>-auth-token-code-verifier",
    provider: "Zavi / Supabase Auth",
    type: "Cookie",
    expiry: "Minutes, during sign-in",
    purpose: "Completes a sign-in securely (PKCE).",
    pattern: /^sb-.*code-verifier$/,
  },
  {
    name: "zavi_consent_v1",
    provider: "Zavi",
    type: "Cookie",
    expiry: "180 days",
    purpose: "Stores your cookie choice so we do not ask again.",
    pattern: /^zavi_consent_v1$/,
  },
  {
    name: "zavi_region",
    provider: "Zavi",
    type: "Cookie",
    expiry: "1 day",
    purpose: "Whether you are in the EU, EEA or UK (from your country, never your address), so Google Analytics waits for your yes there.",
    pattern: /^zavi_region$/,
  },
  {
    name: "__epv_<run>",
    provider: "Zavi",
    type: "Cookie",
    expiry: "Session",
    purpose: "Lets you open a preview of a site the engineer agent built for you. Only set when you open a preview.",
    pattern: /^__epv_/,
  },
  {
    name: "zavi:dark",
    provider: "Zavi",
    type: "Local storage",
    expiry: "Until cleared",
    purpose: "Remembers your light / dark theme choice.",
    pattern: /^zavi:dark$/,
  },
  {
    name: "zavi:*, zavi.*, zavi_* layout preferences",
    provider: "Zavi",
    type: "Local storage",
    expiry: "Until cleared",
    purpose: "Remembers workspace layout you set: pane widths, column order, collapsed panels, dismissed notices, tool-detail view.",
    pattern: /^zavi[:._](?!consent|cookie-banner)/,
  },
  {
    name: "praxis.brain.view, brainTab_systemCore_collapsed",
    provider: "Zavi",
    type: "Local storage",
    expiry: "Until cleared",
    purpose: "Remembers how you last viewed the company brain.",
    pattern: /^(praxis\.brain\.|brainTab_)/,
  },
  {
    name: "praxis_pending_build",
    provider: "Zavi",
    type: "Local storage",
    expiry: "Until sign-up completes",
    purpose: "Carries the build you described on /start across the sign-up redirect, so you do not type it twice.",
    pattern: /^praxis_pending_build$/,
  },
  {
    name: "zavi.launch-video.job",
    provider: "Zavi",
    type: "Local storage",
    expiry: "30 minutes",
    purpose: "Lets the launch-video page find your video job again after a reload.",
    pattern: /^zavi\.launch-video\./,
  },
  {
    name: "zavi:cookie-banner-dismissed, praxis:connect-return, praxis:refine-seed:*, composer seeds, reload guard",
    provider: "Zavi",
    type: "Session storage",
    expiry: "Until you close the tab",
    purpose: "Remembers you closed the cookie banner without choosing (it stays closed for this tab only); brings you back to the right page after connecting an integration; hands a draft between panels; stops a reload loop after a deploy.",
    pattern: /^(praxis:|zavi:cookie-banner-dismissed$|zavi:next-chunk-reload-at$|zavi\.buildStartingAt$)/,
  },
  {
    name: "Cloudflare Turnstile",
    provider: "Cloudflare",
    type: "Cookie / storage",
    expiry: "Per Cloudflare's policy",
    purpose: "Bot protection on the launch-video form. Loaded only on that page.",
    pattern: /^cf_/,
  },
];

export const ANALYTICS: CookieRow[] = [
  {
    name: "ph_<key>_posthog",
    provider: "PostHog",
    type: "Cookie",
    expiry: "1 year",
    purpose: "Anonymous visitor ID and session, so page views on our public pages can be counted. Shared across zaviagent.com subdomains.",
    pattern: /^ph_(?!pv:)/,
  },
  {
    name: "ph_<key>_posthog and other ph_* keys",
    provider: "PostHog",
    type: "Local storage",
    expiry: "Until cleared or withdrawn",
    purpose: "A second copy of the same data (posthog-js keeps both by default).",
    pattern: /^ph_(?!pv:)/,
  },
  {
    name: "__ph_opt_in_out_<key>, __mp_opt_in_out_<token>",
    provider: "PostHog / Mixpanel",
    type: "Cookie / storage",
    expiry: "Until withdrawn",
    purpose: "Records your analytics choice.",
    pattern: /^__(ph|mp)_opt_in_out_/,
  },
  {
    name: "mp_<token>_mixpanel",
    provider: "Mixpanel",
    type: "Local storage",
    expiry: "Until cleared or withdrawn",
    purpose: "Analytics identity and event queue. Once you are signed in, linked to your account ID and email.",
    pattern: /^mp_(?!pv:|signup:|login:)/,
  },
  {
    name: "ph_pv:<url>, mp_pv:<path>, mp_signup:<id>, mp_login:<id>",
    provider: "Zavi",
    type: "Session storage",
    expiry: "Until you close the tab",
    purpose: "Stops one page view, sign-up or login being counted twice.",
    pattern: /^(ph_pv:|mp_pv:|mp_signup:|mp_login:)/,
  },
  {
    name: "_ga, _ga_<id>",
    provider: "Google Analytics",
    type: "Cookie",
    expiry: "2 years",
    purpose: "Anonymous visitor ID and session, so visits to our public pages and sign-up steps can be counted. Advertising features and Google signals are off.",
    pattern: /^(_ga$|_ga_|_gid$|_gat($|_))/,
  },
  {
    name: "zft_first_touch",
    provider: "Zavi",
    type: "Local storage",
    expiry: "Until cleared or withdrawn",
    purpose: "Remembers how you first found Zavi (campaign tags, creator/channel label, referring site, first page) so we can see which channels bring sign-ups.",
    pattern: /^zft_/,
  },
];

export const EMBEDDED: { name: string; where: string; url: string }[] = [
  {
    name: "Cal.com",
    where: "The booking calendar on /support (also reached via /talk-to-team).",
    url: "https://cal.com/privacy",
  },
];

export const ALL_ROWS: CookieRow[] = [...NECESSARY, ...ANALYTICS];
