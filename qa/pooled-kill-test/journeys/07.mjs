import { main } from "../lib/journey.mjs";

await main({
  n: "07", title: "P2P car rental (dedicated)", url: import.meta.url,
  dedicated: {
    manualFlows: [
      { id: "host_lists_car", what: "a host signs up and lists a car with photos" },
      { id: "renter_requests_dates", what: "a renter requests dates; only that car's host sees the request" },
      { id: "host_accepts_blocks_dates", what: "the host accepts; overlapping dates for that car are refused" },
      { id: "payment_test_mode", what: "checkout runs in Stripe test mode and the host payout is recorded" },
    ],
  },
}, null);
