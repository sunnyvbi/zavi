
import { writeNote } from "../src/services/memory/index";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

const BODY = `## Guest protection plan pricing (Upcar)

The guest protection plan fee is charged to the **guest** on top of the trip price. For standard (leisure) trips it is a percentage of the trip price with a per-day dollar minimum:

| Plan | Fee | Daily minimum |
|---|---|---|
| Minimum | 20% of trip price | $5/day |
| Standard | 40% of trip price | $10/day |
| Premium | 60% of trip price | $20/day |
| Decline / None | $0 (guest waives protection) | — |

Notes:
- Gig / long-stay (server) trips use flat daily rates instead of a percentage: roughly $10–$35/day depending on plan and trip length.
- Subscription protection (for car-subscription bookings) is a percentage of the monthly base price: Essential 30%, Enhanced 50%.
- This is the GUEST protection plan (distinct from the HOST protection plan tiers 100/90/80/75-default/60%, which set the host's payout share).
- Source of truth in code: Upcar backend \`tripPriceController.ts\` (guest protection tiers) + \`subscriptionPricingUtils.ts\`. For the exact charge on a specific trip, the value is computed from these against that trip's price.`;

async function main() {
  const r = await writeNote(TENANT, {
    title: "Guest protection plan pricing",
    body_markdown: BODY,
    source: "human",
    note_type: "tenant_reference",
    trust_tier: 0,
    tags: ["pricing", "protection-plan", "guest", "insurance"],
  });
  console.log(`seeded guest-protection-pricing note: id=${r.note_id} chunks=${r.chunks}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
