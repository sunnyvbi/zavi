
import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({ serviceClient: vi.fn(() => ({ from: vi.fn() })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: vi.fn() }));
vi.mock("@/services/tools/whatsapp/_client", () => ({
  postWhatsAppReply: vi.fn(),
  postWhatsAppWindowTemplate: vi.fn(),
}));
vi.mock("@/services/tools/telegram/_client", () => ({ postTelegramReply: vi.fn() }));
vi.mock("@/services/tools/discord/_client", () => ({ postDiscordReply: vi.fn() }));
vi.mock("@/services/connectors/whatsapp/binding", () => ({ findEnabledWhatsAppBinding: vi.fn() }));

import {
  reminderDeliveryDeps,
  isReminderDefer,
  REMINDER_DEFER_PREFIX,
} from "@/services/agents/reminder-delivery-deps";
import { reminderDeliverSchema } from "@/services/agents/reminders";

describe("reminderDeliveryDeps", () => {
  const deps = reminderDeliveryDeps({ scrub: (t) => t });

  it("wires a sender for EVERY delivery target the schema accepts", () => {
    const senderFor: Record<string, keyof typeof deps> = {
      chat_thread: "postToThread",
      slack_dm: "postToSlackDm",
      slack_thread: "postToSlack",
      slack_channel: "postToSlack",
      whatsapp: "postToWhatsApp",
      imessage: "postToIMessage",
      telegram: "postToTelegram",
      discord: "postToDiscord",
    };
    const kinds = reminderDeliverSchema.options.map(
      (o) => (o.shape.kind as { value: string }).value,
    );
    expect(kinds.sort()).toEqual(Object.keys(senderFor).sort());
    for (const kind of kinds) {
      expect(typeof deps[senderFor[kind]]).toBe("function");
    }
  });

  it("treats only the defer sentinel as a defer", () => {
    expect(isReminderDefer(`${REMINDER_DEFER_PREFIX}not this host`)).toBe(true);
    expect(isReminderDefer("channel_not_found")).toBe(false);
    expect(isReminderDefer(null)).toBe(false);
  });
});
