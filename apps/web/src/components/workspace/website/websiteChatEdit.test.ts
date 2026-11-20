
import { describe, it, expect, vi } from "vitest";
import {
  BUILD_REFINE_CONFIRMATION,
  resolveBuildRefine,
  resolveWebsiteChatEdit,
  askAiFailureMessage,
} from "./websiteChatEdit";

describe("resolveWebsiteChatEdit", () => {
  it("passes through a question: the normal chat runs", async () => {
    const out = await resolveWebsiteChatEdit("what did the team do this week?", { classify: async () => "operator" });
    expect(out).toEqual({ handled: false });
  });

  it("an old in-preview edit route the classifier never sends is passed through, never applied", async () => {
    const out = await resolveWebsiteChatEdit("change the tagline", { classify: async () => "app_edit_inline" });
    expect(out).toEqual({ handled: false });
  });

  it("passes through when the classifier is unreachable or says nothing (never swallows the message)", async () => {
    expect(await resolveWebsiteChatEdit("change the tagline", { classify: async () => { throw new Error("network"); } })).toEqual({ handled: false });
    expect(await resolveWebsiteChatEdit("change the tagline", { classify: async () => undefined })).toEqual({ handled: false });
  });
});

describe("askAiFailureMessage", () => {
  it("shows the server's chat line, which is the only text written for a reader", () => {
    expect(askAiFailureMessage(422, { code: "no_editable_change", chat: "I couldn't turn that into an edit.", message: "x" })).toBe("I couldn't turn that into an edit.");
    expect(askAiFailureMessage(502, { chat: "   " , message: "" })).toBe("The AI didn't answer. Try again in a moment.");
  });

  it("never puts the database's own words on screen", () => {
    const leaks = [
      'new row violates row-level security policy for table "website_edits"',
      'duplicate key value violates unique constraint "website_edits_tenant_id_app_id_selector_key"',
      'column "selector" of relation "website_edits" does not exist',
      'JWT expired at 1790000000, current time 1790000001',
    ];
    for (const message of leaks) {
      const shown = askAiFailureMessage(500, { code: "write_failed", message });
      expect(shown, message).toBe("Something went wrong (500). Try again.");
      for (const word of ["website_edits", "row-level security", "constraint", "relation", "JWT"]) {
        expect(shown.includes(word), `${word} leaked`).toBe(false);
      }
    }
  });

  it("still prefers a chat line the route wrote for a 500", () => {
    expect(
      askAiFailureMessage(500, { code: "write_failed", chat: "I couldn't save that edit.", message: 'relation "website_edits" does not exist' }),
    ).toBe("I couldn't save that edit.");
  });

  it("names the gate when the body is missing", () => {
    expect(askAiFailureMessage(422)).toContain("text, color, or link");
    expect(askAiFailureMessage(403)).toContain("isn't registered to your workspace");
    expect(askAiFailureMessage(401)).toContain("Sign in again");
    expect(askAiFailureMessage(418)).toBe("Something went wrong (418). Try again.");
  });
});

describe("Build chat: an app change updates the same build", () => {
  it("sends a structural change to this build's refine, not to a new agent chat", async () => {
    const refine = vi.fn(async () => ({ ok: true as const }));
    const out = await resolveWebsiteChatEdit("add a pricing section below the hero", {
      classify: async () => "app_edit",
      refine,
    });
    expect(refine).toHaveBeenCalledWith("add a pricing section below the hero");
    expect(out).toEqual({ handled: true, consumed: true, system: BUILD_REFINE_CONFIRMATION });
  });

  it("keeps a refused update in the chat with the server's reason, and keeps the user's bubble", async () => {
    const out = await resolveWebsiteChatEdit("add a pricing section", {
      classify: async () => "app_edit",
      refine: async () => ({ ok: false as const, message: "Your app is still building." }),
    });
    expect(out).toEqual({ handled: true, system: "Your app is still building." });
  });

  it("leaves questions to the normal chat even inside Build", async () => {
    const refine = vi.fn(async () => ({ ok: true as const }));
    const out = await resolveWebsiteChatEdit("what does this page say?", {
      classify: async () => "operator",
      refine,
    });
    expect(out).toEqual({ handled: false });
    expect(refine).not.toHaveBeenCalled();
  });

  it("fails closed inside Build when classification is unavailable instead of creating an unrelated operator session", async () => {
    const refine = vi.fn(async () => ({ ok: true as const }));
    const out = await resolveWebsiteChatEdit("add a pricing section", {
      classify: async () => {
        throw new Error("network");
      },
      refine,
    });

    expect(out.handled).toBe(true);
    expect(out.system).toContain("didn't start a separate chat");
    expect(refine).not.toHaveBeenCalled();
  });

  it("shows the server's own refusal inside Build instead of asking for a retry that cannot work", async () => {
    const refine = vi.fn(async () => ({ ok: true as const }));
    const out = await resolveWebsiteChatEdit("add a pricing section", {
      classify: async () => ({ rejected: "App changes aren't turned on for this workspace." }),
      refine,
    });

    expect(out).toEqual({ handled: true, system: "App changes aren't turned on for this workspace." });
    expect(refine).not.toHaveBeenCalled();
  });

  it("does not change the Website tab, which has no build to refine", async () => {
    const out = await resolveWebsiteChatEdit("add a pricing section", {
      classify: async () => "app_edit",
    });
    expect(out).toEqual({ handled: false });
  });
});

describe("resolveBuildRefine: a refused edit", () => {
  it("a credit refusal (free edits used / wallet short) becomes the composer's credit wall, not a system line", async () => {
    const msg = "You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.";
    const out = await resolveBuildRefine("add a pricing page", async () => ({ ok: false, message: msg, credit: true }));
    expect(out).toEqual({ handled: true, creditWall: msg });
  });

  it("any other refusal stays a plain system line", async () => {
    const out = await resolveBuildRefine("add a pricing page", async () => ({ ok: false, message: "busy" }));
    expect(out).toEqual({ handled: true, system: "busy" });
  });
});

describe("resolveBuildRefine: a change held while the site builds", () => {
  const HELD = "Your site is still building. I'll make this change as soon as it finishes.";

  it("says it is held, never that it is being applied, and clears the box", async () => {
    const out = await resolveBuildRefine("Our prices start at $80", async () => ({ ok: true, held: HELD }));
    expect(out).toEqual({ handled: true, consumed: true, system: HELD });
    expect(out.system).not.toContain("applying");
  });

  it("keeps the server's note in front of the held line", async () => {
    const out = await resolveBuildRefine("Remove the old bookings", async () => ({ ok: true, held: HELD, note: "Stored bookings stay." }));
    expect(out.system).toBe(`Stored bookings stay. ${HELD}`);
  });
});
