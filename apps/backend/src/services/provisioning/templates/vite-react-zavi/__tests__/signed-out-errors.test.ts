import { describe, expect, it } from "vitest";
import { createZavi, type KeyValueStorage } from "../files/src/zavi/client";
import { DevStore } from "../files/src/zavi/devstore";
import { createLocalServer, type DevSeed } from "../files/src/zavi/local";
import { ZaviError, needsSignIn, userMessage } from "../files/src/zavi/errors";
import { validateManifest } from "../manifest";
import { TEMPLATE_FILES } from "../template-files.generated";

const ORIGIN = "http://localhost:5173";
const SITE = "00000000-0000-4000-8000-00000000d0e0";

function mem(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function bookingSite() {
  const manifest = JSON.parse(TEMPLATE_FILES["zavi-site.json"]);
  manifest.collections.bookings = {
    rules: { create: ["signed_in"], list: ["owner", "admin"], get: ["owner", "admin"], update: ["owner"], delete: ["admin"] },
    schema: { type: "object", required: ["slot"], properties: { slot: { type: "string", maxLength: 40 } } },
  };
  manifest.collections.notes = {
    rules: { create: ["admin"], list: ["admin"], get: ["admin"] },
    schema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 40 } } },
  };
  const m = validateManifest(manifest);
  if (!m.ok) throw new Error(JSON.stringify(m.issues));
  const server = createLocalServer({
    store: new DevStore({ manifest: m.value }),
    siteId: SITE,
    persist: null,
    seed: JSON.parse(TEMPLATE_FILES["dev-seed.json"]) as DevSeed,
    objectUrl: () => `blob:${ORIGIN}/f00d`,
  });
  return () => createZavi({ fetch: server.fetch, origin: ORIGIN, siteId: async () => SITE, storage: mem() });
}

async function caught(p: Promise<unknown>): Promise<ZaviError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ZaviError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

describe("a signed-out visitor refused by the rules is asked to sign in, not to contact the owner", () => {
  it("creating a booking that needs a signed-in customer", async () => {
    const tab = bookingSite();
    const e = await caught(tab().data.collection("bookings").create({ slot: "10:00" }));
    expect(e).toMatchObject({ code: "not_allowed", signedOut: true });
    expect(needsSignIn(e)).toBe(true);
    expect(userMessage(e)).toBe("Please sign in to continue.");
  });

  it("changing a record while signed out", async () => {
    const tab = bookingSite();
    const e = await caught(tab().data.collection("bookings").update("00000000-0000-4000-8000-000000000001", { slot: "11:00" }));
    expect(needsSignIn(e)).toBe(true);
    expect(userMessage(e)).toMatch(/sign in/i);
  });

  it("the same refusal for a signed-in customer is not a sign-in problem", async () => {
    const tab = bookingSite();
    const z = tab();
    await z.auth.signUp({ email: "cust@site.test", password: "password-c" });
    await z.data.collection("bookings").create({ slot: "10:00" });
    const e = await caught(z.data.collection("notes").create({ text: "hi" }));
    expect(e).toMatchObject({ code: "not_allowed", signedOut: false });
    expect(needsSignIn(e)).toBe(false);
    expect(userMessage(e)).not.toMatch(/sign in/i);
  });

  it("a signed-out visitor setting an admin-only field is not told to sign in", async () => {
    const tab = bookingSite();
    const e = await caught(tab().data.collection("submissions").create({ name: "P", body: "b", status: "done" }));
    expect(e).toMatchObject({ reason: "field_not_writable: status", signedOut: true });
    expect(needsSignIn(e)).toBe(false);
  });

  it("a server function in the preview says where it works instead of blaming the server", async () => {
    const tab = bookingSite();
    const e = await caught(tab().functions.call("checkout", {}));
    expect(e.reason).toBe("function_preview_only");
    expect(userMessage(e)).toBe("This works on the published site, not in the preview.");
  });
});
