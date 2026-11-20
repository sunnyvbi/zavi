import { describe, it, expect } from "vitest";
import {
  plainDirectEngineerReply,
  replaceInternalTermsForCustomer,
  BUILD_SITE_PHRASE,
} from "../direct-reply-plain-words";
import { findInternalJargon, replaceBuildRepoRefs } from "../internal-jargon";
import { STATUS_PHRASES } from "../run-status-projection";

const FIXTURE =
  "Repeating the ask doesn't disambiguate it — `repo_hint` came in as `acme/ios`, which is the iOS app repo, not a web landing page target. " +
  "And you already have a live landing page shipped this morning on the Zavi-build scaffold (`Praxis-build/acme-6ec4d609`) plus your main marketing site.\n\n" +
  "Which of these do you actually want?\n\n" +
  "- **A) Iterate on the Zavi-build scaffold** that shipped this morning (`Praxis-build/acme-6ec4d609`) — polish copy/layout on what's already live there.\n" +
  "- **B) Ship a new landing page into `acme/web`** (public web app repo).";

describe("direct engineer reply — a question keeps its prose, internal tokens go", () => {
  it("rewrites the prod fixture without losing the question or the customer's repos", () => {
    const out = plainDirectEngineerReply({
      text: FIXTURE,
      parse_ok: true,
      side_effect: { kind: "refused" },
    });
    expect(out.mode).toBe("replaced");
    expect(out.text).not.toMatch(/repo_hint|Praxis-build/i);
    expect(findInternalJargon(out.text)).toEqual([]);
    expect(out.text).toContain("this chat was set to `acme/ios`, which is the iOS app repo");
    expect(out.text).toContain(`on the Zavi-build scaffold (${BUILD_SITE_PHRASE})`);
    expect(out.text).toContain("Which of these do you actually want?");
    expect(out.text).toContain("**B) Ship a new landing page into `acme/web`**");
  });

  it("false positive: a customer's own owner/repo names and file paths are byte-identical", () => {
    const text = "I'll change `src/app/page.tsx` in `acme/web`. Want me to also touch `acme/web-private`?";
    expect(plainDirectEngineerReply({ text, parse_ok: true }).text).toBe(text);
    expect(replaceBuildRepoRefs("acme/praxis-builder is yours", "x")).toBe("acme/praxis-builder is yours");
  });

  it("any other repo_hint mention becomes a plain noun in place; no sentence is dropped", () => {
    const r = replaceInternalTermsForCustomer("The fix is ready. I ignored the repo_hint default. Reply yes to open the PR.");
    expect(r.text).toBe("The fix is ready. I ignored the repo for this chat default. Reply yes to open the PR.");
    expect(
      replaceInternalTermsForCustomer("`repo_hint` is missing, so choose acme/web or acme/ios.").text,
    ).toBe("The repo for this chat is missing, so choose acme/web or acme/ios.");
    expect(
      replaceInternalTermsForCustomer("`repo_hint` is missing; please choose acme/web or acme/ios.").text,
    ).toBe("The repo for this chat is missing; please choose acme/web or acme/ios.");
  });

  it("a repo_hint that is not an owner/repo never becomes 'set to'", () => {
    for (const v of ["missing", "unset", "null", "empty", "`none`", "n/a"]) {
      const r = replaceInternalTermsForCustomer(`\`repo_hint\` is ${v}. Which repo should I use?`);
      expect(r.text).toBe(`The repo for this chat is ${v}. Which repo should I use?`);
      expect(r.text).not.toMatch(/set to/);
    }
    expect(replaceInternalTermsForCustomer("repo_hint was acme/web, so I used it.").text).toBe(
      "This chat was set to acme/web, so I used it.",
    );
  });

  it("leaves URLs and Markdown link destinations intact", () => {
    const link = "See [site](https://github.com/Praxis-build/acme) for the build.";
    expect(replaceBuildRepoRefs(link, BUILD_SITE_PHRASE)).toBe(link);
    const bare = "Code: https://github.com/Praxis-build/acme/tree/main and `Praxis-build/acme`.";
    expect(replaceBuildRepoRefs(bare, BUILD_SITE_PHRASE)).toBe(
      `Code: https://github.com/Praxis-build/acme/tree/main and ${BUILD_SITE_PHRASE}.`,
    );
  });

  it("capitalises the build-site phrase at a sentence start", () => {
    expect(replaceBuildRepoRefs("Done. `Praxis-build/x-1` is live.", BUILD_SITE_PHRASE)).toBe(
      "Done. The site Zavi built for you is live.",
    );
  });
});

describe("direct engineer reply — a result becomes the status line + summary", () => {
  it("a no_change run whose write-up is for an engineer leads with the summary, then the server phrase", () => {
    const out = plainDirectEngineerReply({
      text: "No envelope emitted. The sandbox is on `Praxis-build/acme-1`, so nothing to ship.",
      parse_ok: true,
      side_effect: { kind: "refused", reason_code: "no_change" },
      customer_summary: "Your checkout already shows the credit, so nothing needed changing.",
    });
    expect(out.mode).toBe("status");
    expect(out.text).toBe(
      `Your checkout already shows the credit, so nothing needed changing.\n\n${STATUS_PHRASES.no_change}`,
    );
  });

  it("a no_change run leads with the summary even when the write-up has no internal jargon", () => {
    const out = plainDirectEngineerReply({
      text: "I checked every public table: RLS is already enabled on all of them, so the alert is stale.",
      parse_ok: true,
      side_effect: { kind: "refused", reason_code: "no_change" },
      customer_summary: "Row-level security is already on for every table, so nothing needed fixing.",
    });
    expect(out.mode).toBe("status");
    expect(out.text).toBe(
      `Row-level security is already on for every table, so nothing needed fixing.\n\n${STATUS_PHRASES.no_change}`,
    );
  });

  it("a no_change refusal without a summary and without jargon keeps the prose", () => {
    const text = "I checked every public table: RLS is already enabled on all of them.";
    const out = plainDirectEngineerReply({
      text,
      parse_ok: true,
      side_effect: { kind: "refused", reason_code: "no_change" },
    });
    expect(out).toEqual({ text, mode: "unchanged" });
  });

  it("a refusal that needs input keeps its options, even with no question mark", () => {
    const out = plainDirectEngineerReply({
      text: "The `repo_hint` default points nowhere useful. Please choose acme/web or acme/ios.",
      parse_ok: true,
      side_effect: { kind: "refused", reason_code: "needs_input" },
    });
    expect(out.mode).toBe("replaced");
    expect(out.text).toBe("The repo for this chat default points nowhere useful. Please choose acme/web or acme/ios.");
  });

  it("a diagnostic and its choices in one sentence keep the choices", () => {
    const out = plainDirectEngineerReply({
      text: "`repo_hint` is missing, so choose acme/web or acme/ios. I'll wait for your choice.",
      parse_ok: true,
      side_effect: { kind: "refused", reason_code: "needs_input" },
    });
    expect(out.text).toBe(
      "The repo for this chat is missing, so choose acme/web or acme/ios. I'll wait for your choice.",
    );
    expect(out.text).not.toMatch(/repo_hint/);
  });

  it("a refusal listing options keeps them without a reason code", () => {
    const text = "Nothing shipped from the sandbox.\n\n- A) acme/web\n- B) acme/ios";
    const out = plainDirectEngineerReply({ text, parse_ok: true, side_effect: { kind: "refused" } });
    expect(out.mode).not.toBe("status");
    expect(out.text).toContain("- A) acme/web");
  });

  it("a clean reply is untouched", () => {
    const text = "Opened the change. Reply **`yes`** to open the PR, or tell me what to adjust.";
    expect(plainDirectEngineerReply({ text, parse_ok: true, side_effect: { kind: "shipped" } })).toEqual({
      text,
      mode: "unchanged",
    });
  });
});

describe("repo_hint replacement keeps prose and customer names intact", () => {
  it("consumes any determiner, so no 'a the' / 'your the'", () => {
    expect(replaceInternalTermsForCustomer("Choose a repo_hint before I continue.").text).toBe(
      "Choose the repo for this chat before I continue.",
    );
    expect(replaceInternalTermsForCustomer("I think your repo_hint is missing.").text).toBe(
      "I think the repo for this chat is missing.",
    );
  });
  it("never touches a customer's own path, filename or URL", () => {
    const text = "Edit `src/repo_hint.ts`, then open https://github.com/acme/repo_hint.";
    expect(replaceInternalTermsForCustomer(text).text).toBe(text);
  });
});
