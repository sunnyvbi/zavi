
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { settingsFieldRole, SETTINGS_FIELD_ROLES, writesElsewhere } from "@zavi/shared";

const ID_PATTERN = String.raw`^\s*(?:kind:\s*["'][a-z_]+["'],\s*)?id:\s*["']([a-z][a-z0-9_]*)["'],?`;

const PLATFORMS = join(
  __dirname,
  "..", "..", "..", "..", "..",
  "web", "src", "components", "workspace", "actions", "platforms",
);

function declaredFields(): Array<{ slug: string; fieldId: string }> {
  const out: Array<{ slug: string; fieldId: string }> = [];
  for (const file of readdirSync(PLATFORMS)) {
    if (!file.endsWith(".ts") || file === "index.ts" || file === "_shared.ts") continue;
    const slug = file.replace(/\.ts$/, "");
    const src = readFileSync(join(PLATFORMS, file), "utf-8");
    for (const m of src.matchAll(new RegExp(ID_PATTERN, "gm"))) {
      if (writesElsewhere(m[1])) continue;
      out.push({ slug, fieldId: m[1] });
    }
  }
  return out;
}

describe("every declared settings field has a role", () => {
  it("finds the platform rows at all (guards the path, not the rule)", () => {
    const found = declaredFields();
    expect(found.length).toBeGreaterThan(20);
    expect(found).toEqual(
      expect.arrayContaining([{ slug: "instagram_organic", fieldId: "handle" }]),
    );
  });

  it("covers all of them", () => {
    const missing = declaredFields().filter(
      ({ slug, fieldId }) => settingsFieldRole(slug, fieldId) === null,
    );
    expect(
      missing.map(({ slug, fieldId }) => `${slug}:${fieldId}`),
      "Add the field to SETTINGS_FIELD_ROLES in packages/shared. An account field " +
        "with no role is the one that matters: the run cannot tell the company's " +
        "own handle from a rival's.",
    ).toEqual([]);
  });

  it("holds no role for a field whose value lives in another store", () => {
    expect(settingsFieldRole("google_ads", "budget")).toBeNull();
    expect(writesElsewhere("budget")).toBe(true);
  });

  it("holds no role for a field the web no longer declares", () => {
    const declared = new Set(declaredFields().map(({ slug, fieldId }) => `${slug}:${fieldId}`));
    const stale = Object.keys(SETTINGS_FIELD_ROLES).filter((k) => !declared.has(k));
    expect(stale, "Remove the role for a settings field that no longer exists").toEqual([]);
  });
});

describe("the roles that carry a claim are the ones that need to be right", () => {
  it("never calls a list of other people's accounts the company's own", () => {
    for (const key of [
      "instagram_organic:competitors",
      "linkedin_organic:targets",
      "reddit_organic:competitors",
    ]) {
      expect(SETTINGS_FIELD_ROLES[key], key).toBe("other_accounts");
    }
  });

  it("keeps the four kinds of number apart", () => {
    expect(settingsFieldRole("chatgpt_ads", "tcpa")).toBe("target");
    expect(settingsFieldRole("linkedin_ads", "deal_value")).toBe("worth");
  });

  it("keys by channel AND field, because the same id means different things", () => {
    expect(settingsFieldRole("instagram_organic", "handle")).toBe("own_account");
    expect(settingsFieldRole("youtube_organic", "handle")).toBe("own_account");
    expect(settingsFieldRole("chatgpt_ads", "tcpa")).toBe("target");
    expect(settingsFieldRole("google_ads", "tcpa")).toBe("target");
    expect(settingsFieldRole("instagram_organic", "tcpa")).toBeNull();
    expect(settingsFieldRole("linkedin_organic", "handle")).toBeNull();
  });
});

describe("the scrape pattern itself", () => {
  const ids = (src: string) =>
    [...src.matchAll(new RegExp(ID_PATTERN, "gm"))].map((m) => m[1]);

  it("sees a field written as the LAST property, with no trailing comma", () => {
    expect(ids('      id: "handle"\n')).toEqual(["handle"]);
    expect(ids(`      id: 'handle'\n`)).toEqual(["handle"]);
  });

  it("still sees the shape that every current field uses", () => {
    expect(ids('      id: "landing_page",\n      label: "x",\n')).toEqual(["landing_page"]);
  });

  it("sees an id written on the same line as its kind", () => {
    expect(ids('      kind: "number", id: "tcpa", label: "x",\n')).toEqual(["tcpa"]);
  });

  it("does not match an id that is not a settings-shaped literal", () => {
    expect(ids("      id: someVariable,\n")).toEqual([]);
    expect(ids("      id: `tpl_${x}`,\n")).toEqual([]);
    expect(ids('      other_id: "nope",\n')).toEqual([]);
  });
});
