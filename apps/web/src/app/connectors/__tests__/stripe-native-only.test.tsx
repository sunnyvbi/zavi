import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import * as Stripe from "../StripeConnectButton";

describe("Stripe connect is native only", () => {
  it("the tile button has no quick-connect", () => {
    const h = renderToString(<Stripe.StripeConnectButton connected={false} open={false} onToggle={() => {}} />);
    expect(h).toContain("Connect");
    expect(h).not.toMatch(/read-only/i);
  });
  it("the form is the restricted-key form with no read-only link", () => {
    const h = renderToString(<Stripe.StripeForm onClose={() => {}} />);
    expect(h).toContain("Connect Stripe");
    expect(h).not.toMatch(/read-only/i);
    expect("startStripePipedreamConnect" in Stripe).toBe(false);
  });
});
