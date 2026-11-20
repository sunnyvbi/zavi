// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api";
import { PhoneBindForm } from "../PhoneBindForm";
import { TelegramForm } from "../TelegramConnectButton";
import { DiscordForm } from "../DiscordConnectButton";
import { CHAT_CONNECT_POLL_WINDOW_MS, expiresLabel } from "../ChatConnectCard";

const mockFetch = vi.mocked(apiFetch);

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Route = (init?: RequestInit) => Response;

function routes(map: Record<string, Route>) {
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const r = map[path];
    if (!r) throw new Error(`unexpected apiFetch ${path}`);
    return r(init);
  });
}

function calls(path: string) {
  return mockFetch.mock.calls.filter(([p]) => p === path).length;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const reload = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  reload.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WA = {
  "/api/connectors/whatsapp/link": () =>
    json({ wa_url: "https://api.whatsapp.com/send?phone=1555&text=Connect", prefill: "Connect Zavi: t", business_number: "1555" }),
  "/api/connectors/whatsapp/confirm": () => json({ ok: true }),
};

describe("PhoneBindForm (WhatsApp)", () => {
  it.each([
    ["plain", (el: ReactElement<any>) => el],
    ["StrictMode", (el: ReactElement<any>) => <StrictMode>{el}</StrictMode>],
  ])("mints exactly once on open (%s) and shows the link without a click", async (_, wrap) => {
    routes(WA);
    render(wrap(<PhoneBindForm surface="whatsapp" onClose={() => {}} />));
    expect(screen.getByText("Creating link…")).toBeTruthy();
    await flush();
    expect(calls("/api/connectors/whatsapp/link")).toBe(1);
    expect(screen.getByText("Open WhatsApp")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("still needs the typed code and Confirm before /confirm is called", async () => {
    routes(WA);
    render(<PhoneBindForm surface="whatsapp" onClose={() => {}} />);
    await flush();
    expect(calls("/api/connectors/whatsapp/confirm")).toBe(0);
    const confirmBtn = screen.getByText("Confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("K7Q2-9F3M"), { target: { value: " ab12-cd34 " } });
    expect(calls("/api/connectors/whatsapp/confirm")).toBe(0);
    fireEvent.click(screen.getByText("Confirm"));
    await flush();
    const confirmCalls = mockFetch.mock.calls.filter(([p]) => p === "/api/connectors/whatsapp/confirm");
    expect(confirmCalls).toHaveLength(1);
    expect(JSON.parse(String(confirmCalls[0]![1]!.body))).toEqual({ code: "ab12-cd34" });
  });

  it("keeps the error copy and offers Try again when the mint fails", async () => {
    routes({ "/api/connectors/whatsapp/link": () => json({ error: { code: "not_admin" } }, 403) });
    render(<PhoneBindForm surface="whatsapp" onClose={() => {}} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Only an owner or admin can connect WhatsApp.");
    routes(WA);
    fireEvent.click(screen.getByText("Try again"));
    await flush();
    expect(calls("/api/connectors/whatsapp/link")).toBe(2);
    expect(screen.getByText("Open WhatsApp")).toBeTruthy();
  });
});

describe("PhoneBindForm (iMessage)", () => {
  const IM = {
    "/api/connectors/imessage/link": () =>
      json({
        imessage_url: "sms:+13475550100&body=Connect%20Zavi%3A%20t",
        prefill: "Connect Zavi: t",
        line: "+13475550100",
        expires_in: 900,
      }),
    "/api/connectors/imessage/confirm": () => json({ ok: true }),
  };

  it("opens Messages with the prefilled text and offers our line for sending by hand", async () => {
    routes(IM);
    render(<PhoneBindForm surface="imessage" onClose={() => {}} />);
    await flush();
    expect(calls("/api/connectors/imessage/link")).toBe(1);
    const open = screen.getByText("Open Messages") as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("sms:+13475550100&body=Connect%20Zavi%3A%20t");
    expect(screen.getByText("+13475550100")).toBeTruthy();
  });

  it("confirms the typed code against the iMessage route, then reloads", async () => {
    routes(IM);
    render(<PhoneBindForm surface="imessage" onClose={() => {}} />);
    await flush();
    fireEvent.change(screen.getByPlaceholderText("K7Q2-9F3M"), { target: { value: "ab12-cd34" } });
    fireEvent.click(screen.getByText("Confirm"));
    await flush();
    expect(calls("/api/connectors/imessage/confirm")).toBe(1);
    expect(screen.getByText("Connected. You can message your agents from iMessage now.")).toBeTruthy();
  });

  it("names a member's refusal in iMessage terms", async () => {
    routes({ "/api/connectors/imessage/link": () => json({ error: { code: "forbidden" } }, 403) });
    render(<PhoneBindForm surface="imessage" onClose={() => {}} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Only an owner or admin can connect iMessage.");
  });
});

const surfaces = [
  {
    name: "TelegramForm",
    Form: TelegramForm,
    link: "/api/connectors/telegram/link",
    status: "/api/connectors/telegram/status",
    linkBody: { dm_url: "https://t.me/zavi?start=t", group_url: "https://t.me/zavi?startgroup=t" },
    shown: "Connect my DM",
    before: { configured: true, connected: false, chats: 0 },
    after: { configured: true, connected: true, chats: 1 },
  },
  {
    name: "DiscordForm",
    Form: DiscordForm,
    link: "/api/connectors/discord/link",
    status: "/api/connectors/discord/status",
    linkBody: { connect_command: "@Zavi connect ABC123", install_url: null },
    shown: "@Zavi connect ABC123",
    before: { configured: true, connected: false },
    after: { configured: true, connected: true },
  },
] as const;

describe.each(surfaces)("$name", (s) => {
  it.each([
    ["plain", (el: ReactElement<any>) => el],
    ["StrictMode", (el: ReactElement<any>) => <StrictMode>{el}</StrictMode>],
  ])("mints exactly once on open (%s) and shows the link/code without a click", async (_, wrap) => {
    routes({ [s.link]: () => json(s.linkBody), [s.status]: () => json(s.before) });
    render(wrap(<s.Form onClose={() => {}} />));
    await flush();
    expect(calls(s.link)).toBe(1);
    expect(screen.getByText(s.shown)).toBeTruthy();
  });

  it("flips to connected on its own once the polled status changes", async () => {
    vi.useFakeTimers();
    let status: object = s.before;
    routes({ [s.link]: () => json(s.linkBody), [s.status]: () => json(status) });
    render(<s.Form onClose={() => {}} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(reload).not.toHaveBeenCalled();
    status = s.after;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    const n = calls(s.status);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(calls(s.status)).toBe(n);
  });

  it("counts a bind that lands before the first poll (baseline is read before the mint)", async () => {
    vi.useFakeTimers();
    let status: object = s.before;
    routes({
      [s.link]: () => {
        status = s.after;
        return json(s.linkBody);
      },
      [s.status]: () => json(status),
    });
    render(<s.Form onClose={() => {}} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the surface was already connected before the mint", async () => {
    vi.useFakeTimers();
    routes({ [s.link]: () => json(s.linkBody), [s.status]: () => json(s.after) });
    render(<s.Form onClose={() => {}} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops polling on unmount", async () => {
    vi.useFakeTimers();
    routes({ [s.link]: () => json(s.linkBody), [s.status]: () => json(s.before) });
    const { unmount } = render(<s.Form onClose={() => {}} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const n = calls(s.status);
    expect(n).toBeGreaterThan(0);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls(s.status)).toBe(n);
  });

  it("stops polling after the 15 minute window", async () => {
    vi.useFakeTimers();
    routes({ [s.link]: () => json(s.linkBody), [s.status]: () => json(s.before) });
    render(<s.Form onClose={() => {}} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_CONNECT_POLL_WINDOW_MS + 3000);
    });
    const n = calls(s.status);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls(s.status)).toBe(n);
  });
});

describe("TelegramForm chat count", () => {
  it("does not reload when an existing chat is removed while the panel is open", async () => {
    vi.useFakeTimers();
    let status: object = { configured: true, connected: true, chats: 2 };
    routes({
      "/api/connectors/telegram/link": () =>
        json({ dm_url: "https://t.me/zavi?start=t", group_url: "https://t.me/zavi?startgroup=t" }),
      "/api/connectors/telegram/status": () => json(status),
    });
    render(<TelegramForm onClose={() => {}} />);
    await flush();
    status = { configured: true, connected: true, chats: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(reload).not.toHaveBeenCalled();
    status = { configured: true, connected: true, chats: 3 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("closed panel", () => {
  it("does not mint after the pre-read if the panel closed meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch.mockImplementation(async (path: string) => {
      if (path === "/api/connectors/telegram/status") {
        await gate;
        return json({ configured: true, connected: false, chats: 0 });
      }
      return json({ dm_url: "https://t.me/zavi?start=t", group_url: "https://t.me/zavi?startgroup=t" });
    });
    const { unmount } = render(<TelegramForm onClose={() => {}} />);
    await flush();
    unmount();
    release();
    await flush();
    expect(calls("/api/connectors/telegram/link")).toBe(0);
  });
});

describe("what the panel asks the server for", () => {
  const bodies = (path: string) =>
    mockFetch.mock.calls.filter(([p]) => p === path).map(([, init]) => JSON.parse(String((init as RequestInit).body ?? "{}")));

  it("opening a panel asks for the live link (no fresh flag); 'Get a new one' asks for a fresh one", async () => {
    const s = surfaces[0];
    routes({ [s.link]: () => json(s.linkBody), [s.status]: () => json(s.before) });
    render(<s.Form onClose={() => {}} />);
    await flush();
    expect(bodies(s.link)).toEqual([{}]);
    fireEvent.click(screen.getByText("Get a new one"));
    await flush();
    expect(bodies(s.link)).toEqual([{}, { fresh: true }]);
  });

  it("WhatsApp opens with the live link and 'Try again' asks for a fresh one", async () => {
    routes({ "/api/connectors/whatsapp/link": () => json({ error: { code: "not_admin" } }, 403) });
    render(<PhoneBindForm surface="whatsapp" onClose={() => {}} />);
    await flush();
    routes(WA);
    fireEvent.click(screen.getByText("Try again"));
    await flush();
    expect(bodies("/api/connectors/whatsapp/link")).toEqual([{}, { fresh: true }]);
  });
});

describe("expiry copy and WhatsApp rotation", () => {
  it("shows the real minutes left (a reused link has less than 15)", () => {
    expect(expiresLabel(900)).toBe("Expires in 15 minutes.");
    expect(expiresLabel(420)).toBe("Expires in 7 minutes.");
    expect(expiresLabel(61)).toBe("Expires in 1 minute.");
    expect(expiresLabel(undefined)).toBe("Expires in 15 minutes.");
  });

  it("WhatsApp: 'Get a new link' asks the server for a fresh link", async () => {
    routes({ "/api/connectors/whatsapp/link": () => json({ wa_url: "https://api.whatsapp.com/send?phone=1&text=x", expires_in: 420 }) });
    render(<PhoneBindForm surface="whatsapp" onClose={() => {}} />);
    await flush();
    expect(screen.getByText("Expires in 7 minutes.")).toBeTruthy();
    fireEvent.click(screen.getByText("Get a new link"));
    await flush();
    const bodies = mockFetch.mock.calls.filter(([p]) => p === "/api/connectors/whatsapp/link").map(([, i]) => JSON.parse(String((i as RequestInit).body)));
    expect(bodies).toEqual([{}, { fresh: true }]);
  });
});
