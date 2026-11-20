import { describe, it, expect } from "vitest";
import {
  hostOf,
  deriveWebsiteEditability,
  mapRefineRejection,
} from "../website-chat";
import {
  NoProvisionedRepo,
  ConductorRunNotFound,
  InvalidRefineMessage,
  FleetHalted,
  AppFrozen,
  FreeEditsUsed,
} from "@/services/agents/refine-product";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import {
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
} from "@/services/agents/start-product-build";

describe("hostOf", () => {
  it("extracts hosts and is garbage-safe", () => {
    expect(hostOf("https://app.example.com/pricing")).toBe("app.example.com");
    expect(hostOf("https://app.example.com")).toBe("app.example.com");
    expect(hostOf(null)).toBeNull();
    expect(hostOf(undefined)).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("deriveWebsiteEditability — D6 server-side GROW gate", () => {
  it("editable when the preview IS the built app (no registered marketing URL)", () => {
    expect(
      deriveWebsiteEditability({
        marketingUrl: null,
        builtAppUrl: "https://my-app.onrender.com",
      }),
    ).toEqual({ editable: true });
  });

  it("editable when the registered marketing URL points AT the built app", () => {
    expect(
      deriveWebsiteEditability({
        marketingUrl: "https://my-app.onrender.com/",
        builtAppUrl: "https://my-app.onrender.com",
      }),
    ).toEqual({ editable: true });
  });

  it("NOT editable for a GROW tenant previewing their OWN site", () => {
    expect(
      deriveWebsiteEditability({
        marketingUrl: "https://www.upcar.ai",
        builtAppUrl: "https://handyhub-test.onrender.com",
      }),
    ).toEqual({ editable: false, reason: "previewing_own_site" });
  });

  it("a bound build session makes an own-site preview editable, but never conjures a built app", () => {
    expect(
      deriveWebsiteEditability({
        marketingUrl: "https://www.mohit.dev/",
        builtAppUrl: "https://mohit-93bd8436.onrender.com",
        boundBuild: true,
      }),
    ).toEqual({ editable: true });
    expect(
      deriveWebsiteEditability({ marketingUrl: "https://www.mohit.dev/", builtAppUrl: null, boundBuild: true }),
    ).toEqual({ editable: false, reason: "no_built_app" });
  });

  it("NOT editable when there is no built app at all", () => {
    expect(
      deriveWebsiteEditability({ marketingUrl: "https://www.upcar.ai", builtAppUrl: null }),
    ).toEqual({ editable: false, reason: "no_built_app" });
    expect(
      deriveWebsiteEditability({ marketingUrl: null, builtAppUrl: null }),
    ).toEqual({ editable: false, reason: "no_built_app" });
  });

  it("an unparseable built-app URL is treated as no built app, never as editable", () => {
    expect(
      deriveWebsiteEditability({ marketingUrl: null, builtAppUrl: "garbage" }),
    ).toEqual({ editable: false, reason: "no_built_app" });
  });
});

describe("mapRefineRejection — honest rejection table", () => {
  const cases: Array<[string, unknown, number, string]> = [
    ["invalid message", new InvalidRefineMessage("too_short"), 400, "invalid_refine_message"],
    ["no provisioned repo", new NoProvisionedRepo("none"), 409, "no_provisioned_repo"],
    ["conductor run missing", new ConductorRunNotFound("gone"), 404, "conductor_run_not_found"],
    ["slot taken", new DoubleBuildInFlight("busy"), 409, "build_already_in_progress"],
    ["daily cap", new TooManyBuildsToday("t1", 3, 3), 429, "daily_build_limit_reached"],
    ["budget", new ProvisionBudgetExceeded(5), 402, "provision_budget_exceeded"],
    ["fleet halted", new FleetHalted(), 503, "fleet_halted"],
    ["app frozen", new AppFrozen("frozen"), 423, "app_frozen"],
    ["free edits used", new FreeEditsUsed(), 402, "free_edits_used"],
    ["wallet short for a change", new InsufficientCreditsForBuild(2000, 10, false, "change"), 402, "insufficient_credits_for_build"],
    ["unknown", new Error("boom"), 500, "refine_product_failed"],
  ];

  for (const [label, err, status, code] of cases) {
    it(`${label} → ${status} ${code} with a non-empty chat line`, () => {
      const mapped = mapRefineRejection(err);
      expect(mapped.status).toBe(status);
      expect(mapped.code).toBe(code);
      expect(mapped.chat.length).toBeGreaterThan(10);
    });
  }

  it("out of credits tells the user to top up with the real numbers", () => {
    const { chat } = mapRefineRejection(new InsufficientCreditsForBuild(2000, 800));
    expect(chat).toContain("2,000");
    expect(chat).toContain("800");
    expect(chat).toMatch(/top up/i);
  });

  it("a Free-plan tenant gets the free-plan copy, not the paid shortfall", () => {
    const mapped = mapRefineRejection(new InsufficientCreditsForBuild(2000, 800, true));
    expect(mapped.status).toBe(402);
    expect(mapped.code).toBe("insufficient_credits_for_build");
    expect(mapped.chat).toBe(
      "The free plan's daily credits don't cover this build. Top up or pick a plan in Billing to start it.",
    );
    expect(mapped.chat).not.toContain("2,000");
  });

  it("never claims the change was made", () => {
    for (const [, err] of cases) {
      const { chat } = mapRefineRejection(err);
      expect(chat).not.toMatch(/\b(done|updated|changed it|shipped|live now)\b/i);
    }
  });

  it("maps every rejection to a distinct code", () => {
    const codes = cases.map(([, err]) => mapRefineRejection(err).code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
