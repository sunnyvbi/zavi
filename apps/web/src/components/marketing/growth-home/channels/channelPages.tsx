
import type { ReactNode } from "react";

export type ChannelIconDef = {
  viewBox: string;
  stroked: boolean;
  color: string;
  size: string;
  body: ReactNode;
};

export type ChannelPage = {
  id: string;
  name: string;
  agent: string;
  desc: string;
  note: string;
  icon: ChannelIconDef;
};

export const CHANNEL_PAGES: ChannelPage[] = [
  {
    id: "meta-ads",
    name: "Meta Ads",
    agent: "Meta Ads Agent",
    desc: "Reads every ad set daily, moves budget to what sells, pauses what doesn't, and drafts the next creative to test. Every change waits for your yes.",
    note: "Connects to your ad account in two clicks. Nothing changes without approval.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#0064E0", size: "h-5 w-5", body: (<><path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" /></>) },
  },
  {
    id: "google-ads",
    name: "Google Ads",
    agent: "Google Ads Agent",
    desc: "Cuts wasted search spend, finds the keywords that actually convert, and rewrites the ads that don't. You approve every move.",
    note: "Read-only until you say otherwise.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#3C8BD9", size: "h-5 w-5", body: (<><path d="M3.9998 22.9291C1.7908 22.9291 0 21.1383 0 18.9293s1.7908-3.9998 3.9998-3.9998 3.9998 1.7908 3.9998 3.9998-1.7908 3.9998-3.9998 3.9998zm19.4643-6.0004L15.4632 3.072C14.3586 1.1587 11.9121.5028 9.9988 1.6074S7.4295 5.1585 8.5341 7.0718l8.0009 13.8567c1.1046 1.9133 3.5511 2.5679 5.4644 1.4646 1.9134-1.1046 2.568-3.5511 1.4647-5.4644zM7.5137 4.8438L1.5645 15.1484A4.5 4.5 0 0 1 4 14.4297c2.5597-.0075 4.6248 2.1585 4.4941 4.7148l3.2168-5.5723-3.6094-6.25c-.4499-.7793-.6322-1.6394-.5878-2.4784z" /></>) },
  },
  {
    id: "tiktok-ads",
    name: "TikTok Ads",
    agent: "TikTok Ads Agent",
    desc: "Tests creative fast, scales the winners, and switches off the rest before they burn budget.",
    note: "Works with your existing TikTok Ads account.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" /></>) },
  },
  {
    id: "reddit-ads",
    name: "Reddit Ads",
    agent: "Reddit Ads Agent",
    desc: "Reaches niche communities with ads that read like they belong there, and trims the ones that don't land.",
    note: "Targets by subreddit and interest, with spend capped by you.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#FF4500", size: "h-5 w-5", body: (<><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" /></>) },
  },
  {
    id: "linkedin-ads",
    name: "LinkedIn Ads",
    agent: "LinkedIn Ads Agent",
    desc: "Targets by role and company, drafts the copy, and reports what each campaign really costs per lead.",
    note: "Built for B2B pipelines, not vanity reach.",
    icon: { viewBox: "0 0 448 512", stroked: false, color: "#0A66C2", size: "h-5 w-5", body: (<><path d="M416 32H31.9C14.3 32 0 46.5 0 64.3v383.4C0 465.5 14.3 480 31.9 480H416c17.6 0 32-14.5 32-32.3V64.3c0-17.8-14.4-32.3-32-32.3zM135.4 416H69V202.2h66.5V416zm-33.2-243c-21.3 0-38.5-17.3-38.5-38.5S80.9 96 102.2 96c21.2 0 38.5 17.3 38.5 38.5 0 21.3-17.2 38.5-38.5 38.5zm282.1 243h-66.4V312c0-24.8-.5-56.7-34.5-56.7-34.6 0-39.9 27-39.9 54.9V416h-66.4V202.2h63.7v29.2h.9c8.9-16.8 30.6-34.5 62.9-34.5 67.2 0 79.7 44.3 79.7 101.9V416z" /></>) },
  },
  {
    id: "youtube-ads",
    name: "YouTube Ads",
    agent: "YouTube Ads Agent",
    desc: "Runs and trims video campaigns, finds the placements that convert, and cuts the ones that only rack up views.",
    note: "Uses your Google Ads connection.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#FF0000", size: "h-5 w-5", body: (<><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></>) },
  },
  {
    id: "seo",
    name: "SEO",
    agent: "SEO Agent",
    desc: "Audits your site, finds the keyword gaps, drafts the pages and fixes that close them, and tracks what ranks.",
    note: "Fixes ship as pull requests you can read.",
    icon: { viewBox: "0 0 24 24", stroked: true, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>) },
  },
  {
    id: "geo",
    name: "GEO (AI search)",
    agent: "GEO Agent",
    desc: "Checks whether your brand shows up when people ask ChatGPT, Claude, Perplexity or Gemini about your category, then drafts the content that gets you cited.",
    note: "Tracked weekly, alongside your Google rankings.",
    icon: { viewBox: "0 0 24 24", stroked: true, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" /></>) },
  },
  {
    id: "email",
    name: "Email",
    agent: "Email Agent",
    desc: "Writes and schedules the sends that bring people back: win-backs, launches, and the follow-ups you never get to.",
    note: "Drafts land in your inbox for approval first.",
    icon: { viewBox: "0 0 24 24", stroked: true, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" /><rect x="2" y="4" width="20" height="16" rx="2" /></>) },
  },
  {
    id: "sms",
    name: "SMS",
    agent: "SMS Agent",
    desc: "Short, timed nudges for the moments that matter: abandoned carts, reminders, and re-orders.",
    note: "Opt-in only. Frequency caps you control.",
    icon: { viewBox: "0 0 24 24", stroked: true, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /></>) },
  },
  {
    id: "instagram",
    name: "Instagram",
    agent: "Instagram Agent",
    desc: "Plans posts and Reels around what your audience actually engages with, and drafts captions in your voice.",
    note: "You publish from your own account.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#E1306C", size: "h-5 w-5", body: (<><path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" /></>) },
  },
  {
    id: "x",
    name: "X",
    agent: "X Agent",
    desc: "Drafts posts and threads in your voice, finds the conversations worth joining, and hands you the drafts to edit and post.",
    note: "You post from your own account.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#0e0f11", size: "h-4 w-4", body: (<><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" /></>) },
  },
  {
    id: "reddit",
    name: "Reddit",
    agent: "Reddit Agent",
    desc: "Finds high-intent threads, drafts replies that actually help, and turns Reddit into customers while respecting each community's rules.",
    note: "You post from your own account. Always ban-safe.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#FF4500", size: "h-5 w-5", body: (<><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" /></>) },
  },
  {
    id: "youtube",
    name: "YouTube",
    agent: "YouTube Agent",
    desc: "Hooks, briefs, and clips: Zavi finds the topics your audience searches for and drafts the video plan to match.",
    note: "Works from your channel's real analytics.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#FF0000", size: "h-5 w-5", body: (<><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></>) },
  },
  {
    id: "tiktok",
    name: "TikTok",
    agent: "TikTok Agent",
    desc: "Short video ideas that land, drafted from what's working in your niche this week.",
    note: "Ideas and scripts. You hit record.",
    icon: { viewBox: "0 0 24 24", stroked: false, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" /></>) },
  },
  {
    id: "ugc",
    name: "UGC Videos",
    agent: "UGC Video Agent",
    desc: "Finds a creator to film a video you own, writes the brief they shoot from, and spells out the usage rights before anyone films.",
    note: "Rights and briefs tracked in one place.",
    icon: { viewBox: "0 0 24 24", stroked: true, color: "#0e0f11", size: "h-5 w-5", body: (<><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></>) },
  },
];

export const CHANNELS_PATH = "/channels";

export function channelBySlug(slug: string): ChannelPage | undefined {
  return CHANNEL_PAGES.find((c) => c.id === slug);
}

export function ChannelGlyph({ channel, className }: { channel: ChannelPage; className?: string }) {
  const { icon } = channel;
  return (
    <svg
      aria-hidden="true"
      viewBox={icon.viewBox}
      className={`${className ?? icon.size}`}
      style={{ color: icon.color }}
      {...(icon.stroked
        ? { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
        : { fill: "currentColor", stroke: "currentColor", strokeWidth: 0 })}
    >
      {icon.body}
    </svg>
  );
}
