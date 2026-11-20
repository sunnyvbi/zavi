import { describe, it, expect } from "vitest";
import { fieldsFromWords, describeSite, mergeIntoBrief, tidyFields } from "../chat";
import { moderateForm } from "../authoring";
import { validateGenerateBody } from "../request";

const WORDS =
  "Tartine is a bakery in San Francisco. You walk in in the morning and buy a country loaf " +
  "that was baked that night, and a morning bun still warm.";

const asGenerateBody = (f: Awaited<ReturnType<typeof fieldsFromWords>>, siteUrl: string) => ({
  email: "founder@example.com",
  company: f.product_name,
  product_name: f.product_name,
  one_liner: f.one_liner,
  features: f.features,
  audience: f.audience,
  problem: f.problem,
  metrics: f.metrics,
  regions: f.regions,
  screen: f.screen,
  cta_text: f.cta_text || "Get started",
  cta_url: siteUrl,
  tone: "confident",
  theme: "swiss",
  brief: WORDS,
  grammar: "calm",
});

describe("a site we could not read", () => {
  it("still produces a draft the generate door accepts", async () => {
    const fields = await fieldsFromWords(WORDS, {
      complete: async () => "NAME: Tartine\nONE_LINER: A bakery in San Francisco where you buy a loaf baked that night.",
    });
    const r = validateGenerateBody(asGenerateBody(fields, "https://tartinebakery.com/"));
    expect(r.ok ? "ok" : r.error).toBe("ok");
  });

  it("accepts it even when the model call fails, from their words alone", async () => {
    const fields = await fieldsFromWords(WORDS, {
      complete: async () => {
        throw new Error("model down");
      },
    });
    expect(fields.product_name).toBe("Tartine is a bakery in San Francisco");
    expect(fields.one_liner).toContain("bakery in San Francisco");
    const r = validateGenerateBody(asGenerateBody(fields, "https://tartinebakery.com/"));
    expect(r.ok ? "ok" : r.error).toBe("ok");
  });

  it("is refused by the door when the name is empty, so the test above can fail", async () => {
    const fields = await fieldsFromWords(WORDS, { complete: async () => "" });
    const body = { ...asGenerateBody(fields, "https://tartinebakery.com/"), product_name: "", company: "" };
    expect(validateGenerateBody(body).ok).toBe(false);
  });
});

describe("a model failure never costs the founder their words", () => {
  it("keeps the correction verbatim when the merge fails", async () => {
    const out = await mergeIntoBrief("what the site said", "no, it is for parents", {
      complete: async () => {
        throw new Error("model down");
      },
    });
    expect(out).toContain("no, it is for parents");
  });

  it("falls back to the site's own one-liner when the description fails", async () => {
    const out = await describeSite(
      { product_name: "Acme", one_liner: "Acme sharpens knives", features: "", audience: "", cta_text: "", problem: "", metrics: "", regions: "", screen: "" },
      { complete: async () => "" },
    );
    expect(out).toBe("Acme sharpens knives");
  });
});

describe("nothing the generate door would refuse leaves the chat", () => {
  const FIELDS = {
    product_name: "Acme",
    one_liner: "Acme sharpens knives",
    features: "",
    audience: "",
    cta_text: "",
    problem: "",
    metrics: "",
    regions: "",
    screen: "",
  };

  it("drops metrics whose TOTAL exceeds the door's 200 characters", () => {
    const label = "x".repeat(160);
    const value = "y".repeat(40);
    const out = tidyFields({ ...FIELDS, metrics: `${label}|${value}` });
    expect(out.metrics.length).toBeLessThanOrEqual(200);
  });

  it("keeps a metric that fits", () => {
    const out = tidyFields({ ...FIELDS, metrics: "Customers|1,200" });
    expect(out.metrics).toBe("Customers|1,200");
  });

  it("drops a region list of one, which the intake refuses", () => {
    expect(tidyFields({ ...FIELDS, regions: "Austin" }).regions).toBe("");
    expect(tidyFields({ ...FIELDS, regions: "Austin, Dallas" }).regions).toBe("Austin, Dallas");
  });
});

describe("the field a visitor writes freely is moderated", () => {
  it("sends the brief to the moderation model", async () => {
    let seen = "";
    await moderateForm(
      {
        product_name: "Acme",
        one_liner: "Acme sharpens knives",
        features: "",
        audience: "",
        tone: "clean",
        theme: "swiss",
        cta_text: "Go",
        cta_url: "https://acme.com",
        brief: "SHOW_THIS_EXACT_STRING",
      } as never,
      {
        complete: async (_system: string, user: string) => {
          seen = user;
          return JSON.stringify({ allowed: true });
        },
      },
    );
    expect(seen).toContain("SHOW_THIS_EXACT_STRING");
  });
});

describe("the shortfall loop moves on when a question is answered", () => {
  const runTurn = async (body: Record<string, unknown>) => {
    const { launchVideoPublicChat } = await import("@/routes/public/launch-video-chat");
    let payload: Record<string, unknown> = {};
    const res = {
      status() { return this; },
      json(v: Record<string, unknown>) { payload = v; return this; },
    } as unknown as import("express").Response;
    await launchVideoPublicChat(
      { body, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } } as unknown as import("express").Request,
      res,
    );
    return payload;
  };

  it("asks the SECOND question after the first is answered, not the first again", async () => {
    const prefill = {
      product_name: "X", one_liner: "Y", features: "", audience: "",
      cta_text: "Go", problem: "", metrics: "", regions: "", screen: "",
    };
    const draft = {
      site_url: "https://x.com", email: "", brief: "", grammar: "calm",
      pending: "problem", skipped: [], missing: ["problem", "product_surface"], prefill,
    };
    const out = await runTurn({
      step: "material",
      draft,
      input: "Before this you waited and hoped.",
      missing: ["problem", "product_surface"],
    });
    expect(out.step).toBe("material");
    expect((out.draft as { pending: string }).pending).toBe("product_surface");
    expect((out.draft as { missing: string[] }).missing).not.toContain("problem");
  });
});
