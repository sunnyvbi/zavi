import { describe, expect, it, vi } from "vitest";
import { buildVideoCard } from "../propose_video";
import { repriceVideoCardBody, repriceVideoCards } from "../card-price";

const INPUT = {
  format: "product_demo",
  hook: "Charged upfront, and the owner never answers?",
  objection: "Renters worry about refunds when an owner goes quiet.",
  script: "Booked a car and the owner went quiet? On UpcarAI the refund rule is written down before you pay, so you always know where you stand.",
  caption: "Know the refund rule before you book.",
  scene: "A woman in her thirties on a sunny street",
  presenter_gender: "female",
} as never;

const INTAKE = { prompt: "A woman on a street", intent: "talking_head", premium: false, aspect_ratio: "9:16", script: "Booked a car and the owner went quiet? Here is the rule." };

describe("a video card written before the price fix shows the price Approve charges", () => {
  it("rewrites the stored number in the card text, the Cost row and cost_credits", () => {
    const old = buildVideoCard(INPUT, 956).body;
    const now = repriceVideoCardBody(old, 860) as ReturnType<typeof buildVideoCard>["body"] & { step: { body: string }; exact_change: { rows: Array<{ item: string; after: string }> } };
    expect(now.cost_credits).toBe(860);
    expect(now.step.body).toContain("It costs about 860 credits, charged only when the video arrives");
    expect(now.step.body).not.toContain("956");
    expect(now.exact_change.rows.find((r) => r.item === "Cost")!.after).toBe("860 credits, charged only when the video arrives");
    expect(JSON.stringify(now)).not.toContain("956");
  });

  it("leaves a body alone when the price is unchanged or the card carries no price", () => {
    const body = buildVideoCard(INPUT, 860).body;
    expect(repriceVideoCardBody(body, 860)).toBe(body);
    const plain = { step: { body: "Check the refund wording." } };
    expect(repriceVideoCardBody(plain, 860)).toBe(plain);
  });

  it("reprices only unmade video cards, from their own stored intake", async () => {
    const price = vi.fn(async () => 860);
    const cards = [
      { id: "v-open", body: buildVideoCard(INPUT, 956).body },
      { id: "v-made", body: buildVideoCard(INPUT, 956).body },
      { id: "check", body: { step: { body: "Confirm the wording." } } },
      { id: "v-bad", body: buildVideoCard(INPUT, 1002).body },
    ];
    const rows = [
      { id: "v-open", exec_class: "generated_video.render.v1", exec_status: null, exec_payload: { intake: INTAKE } },
      { id: "v-made", exec_class: "generated_video.render.v1", exec_status: "executed", exec_payload: { intake: INTAKE } },
      { id: "check", exec_class: null, exec_status: null, exec_payload: null },
      { id: "v-bad", exec_class: "generated_video.render.v1", exec_status: null, exec_payload: { intake: { intent: "nope" } } },
    ];
    const out = await repriceVideoCards(cards, rows, price);
    expect((out[0].body as { cost_credits: number }).cost_credits).toBe(860);
    expect((out[1].body as { cost_credits: number }).cost_credits).toBe(956);
    expect(out[2]).toBe(cards[2]);
    expect((out[3].body as { cost_credits: number }).cost_credits).toBe(1002);
    expect(price).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored price when the live price cannot be read", async () => {
    const cards = [{ id: "v", body: buildVideoCard(INPUT, 956).body }];
    const out = await repriceVideoCards(cards, [{ id: "v", exec_class: "generated_video.render.v1", exec_status: null, exec_payload: { intake: INTAKE } }], async () => {
      throw new Error("config down");
    });
    expect(out[0]).toBe(cards[0]);
  });
});
