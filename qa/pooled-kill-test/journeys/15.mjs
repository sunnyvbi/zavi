import { main } from "../lib/journey.mjs";

await main({
  n: "15", title: "AI growth agent (dedicated)", url: import.meta.url,
  dedicated: {
    manualFlows: [
      { id: "waitlist_signup", what: "a visitor joins the waitlist; only the admin sees it" },
      { id: "secrets_server_side", what: "third-party keys live server-side (none in the page source or network responses)" },
      { id: "scheduled_job", what: "a scheduled job runs and writes a report the admin can read" },
    ],
  },
}, null);
