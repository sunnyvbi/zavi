
import { afterEach, describe, expect, it } from "vitest";
import {
  __setCreatorMoneyPortForTest,
  resolveCreatorMoneyPort,
} from "../money-port";
import { offerReturnUrls, realCreatorOfferMoneyPort, wireCreatorMoneyPort } from "../offer-money-port";

afterEach(() => {
  __setCreatorMoneyPortForTest(null);
});

describe("creator money port production wiring", () => {
  it("is unregistered until something wires it", () => {
    __setCreatorMoneyPortForTest(null);
    expect(() => resolveCreatorMoneyPort()).toThrow(/S2\/S3/);
  });

  it("resolves to the real S2/S3 implementation once wired", () => {
    __setCreatorMoneyPortForTest(null);
    wireCreatorMoneyPort();
    const port = resolveCreatorMoneyPort();
    expect(port).toBe(realCreatorOfferMoneyPort);
    expect(typeof port.placeHoldForOffer).toBe("function");
  });

  it("createApp() calls the registrar, so the shipped server can accept an offer", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(join(process.cwd(), "src/app.ts"), "utf8");
    expect(src).toContain("wireCreatorMoneyPort");
    const body = src.slice(src.indexOf("export function createApp("));
    expect(body).toContain("wireCreatorMoneyPort()");
  });

  it("returns the business to the job page, the page that fulfils on ?paid=1", () => {
    const prev = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = "https://www.zaviagent.com/,https://other.example";
    try {
      expect(offerReturnUrls()).toEqual({
        success_url: "https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job={ORDER_ID}&paid=1",
        cancel_url: "https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job={ORDER_ID}&cancelled=1",
      });
    } finally {
      if (prev === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = prev;
    }
  });
});
