
export const TERMS: Array<[string, string]> = [
  ["What you earn", "100% of each referred customer's first 2 monthly subscription payments, then 30% of every payment through their 12th month."],
  ["Which payments", "Zavi subscriptions (Starter, Growth, Pro). A six-month plan counts as six monthly payments: the first two at 100%, the rest at 30%. Credit top-ups are not included."],
  ["Refunds", "A refund, credit or lost chargeback comes off what you earned. Inside the 30-day window it never reaches you; after a payout, it is taken back from your Stripe balance, or from your next commissions."],
  ["Your link", "Works on any page of zaviagent.com. A signup counts for 60 days after the click, and the last link clicked wins."],
  ["When you are paid", "Each commission waits 30 days for refunds. Once what is ready reaches $20 it goes to your bank through Stripe. Your first payout is checked by a person first."],
  ["Who can join", "Anyone approved as a Zavi creator. You set up payouts with Stripe; Stripe handles your tax forms."],
  ["The rules", "Say you are an affiliate when you share your link. No ads on the Zavi name, no spam, no coupon sites, and no referring yourself or your own company. Zavi may withhold commissions earned against these rules."],
];

export type PlanId = "starter" | "growth" | "pro";

export const AFFILIATE_PLANS: ReadonlyArray<{ id: PlanId; name: string; price: number }> = [
  { id: "starter", name: "Starter", price: 20 },
  { id: "growth", name: "Growth", price: 120 },
  { id: "pro", name: "Pro", price: 240 },
];

export const LATER_RATE = 0.3;

export function firstTwo(price: number): number {
  return 2 * price;
}

export function laterTen(price: number): number {
  return Math.round(10 * LATER_RATE * price * 100) / 100;
}

export function yearOne(price: number): number {
  return firstTwo(price) + laterTen(price);
}

export function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
