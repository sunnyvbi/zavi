import { describe, expect, it } from "vitest";
import { Inngest } from "inngest";
import { eventOnlyInngestFunctions } from "../inngest-event-only";

const cron = { opts: { id: "c", triggers: [{ cron: "*/2 * * * *" }] } };
const event = { opts: { id: "e", triggers: [{ event: "agent.run.requested" }] } };
const mixed = { opts: { id: "m", triggers: [{ event: "x" }, { cron: "0 9 * * *" }] } };
const fns = [cron, event, mixed];
const PROD = { INNGEST_SIGNING_KEY: "signkey-prod-x" };
const LOCAL = { INNGEST_DEV: "http://localhost:8288" };
const ids = (out: Array<{ opts: { id: string } }>) => out.map((f) => f.opts.id);

describe("eventOnlyInngestFunctions", () => {
  it("serves every function in prod (signing key, no INNGEST_DEV)", () => {
    expect(eventOnlyInngestFunctions(fns, PROD)).toEqual(fns);
  });

  it("locally drops cron-only functions and strips the cron from mixed ones", () => {
    const out = eventOnlyInngestFunctions(fns, { ...PROD, ...LOCAL });
    expect(ids(out)).toEqual(["e", "m"]);
    expect(out[1].opts.triggers).toEqual([{ event: "x" }]);
    expect(mixed.opts.triggers).toHaveLength(2);
  });

  it("treats a process with no signing key and no INNGEST_DEV as local", () => {
    expect(ids(eventOnlyInngestFunctions(fns, {}))).toEqual(["e", "m"]);
  });

  it.each(["0", "false", "FALSE ", "no"])("treats INNGEST_DEV=%j with a signing key as cloud", (v) => {
    expect(eventOnlyInngestFunctions(fns, { ...PROD, INNGEST_DEV: v })).toEqual(fns);
  });

  it.each(["1", "true"])("treats INNGEST_DEV=%j as local", (v) => {
    expect(ids(eventOnlyInngestFunctions(fns, { ...PROD, INNGEST_DEV: v }))).toEqual(["e", "m"]);
  });

  it("serves crons locally only with INNGEST_LOCAL_CRONS=1", () => {
    expect(eventOnlyInngestFunctions(fns, { ...LOCAL, INNGEST_LOCAL_CRONS: "1" })).toEqual(fns);
  });

  it("a real mixed InngestFunction registers only its event trigger locally", () => {
    const client = new Inngest({ id: "t" });
    const fn = client.createFunction({ id: "mix" }, [{ event: "a.b" }, { cron: "* * * * *" }], async () => null);
    const [out] = eventOnlyInngestFunctions([fn], LOCAL);
    const cfg = (out as unknown as { getConfig: (o: object) => Array<{ triggers: unknown }> }).getConfig({
      baseUrl: new URL("http://localhost:3001/api/inngest"),
      appPrefix: "t",
    });
    expect(cfg[0].triggers).toEqual([{ event: "a.b", expression: undefined }]);
  });
});
