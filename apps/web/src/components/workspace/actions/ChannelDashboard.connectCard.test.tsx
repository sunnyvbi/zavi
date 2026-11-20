// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const m = vi.hoisted(() => ({ composio: vi.fn(async () => {}) }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: m.composio }));

import { AlsoConnect, ConnectCard, connectFirst, connectable, connectorNames } from "./ChannelDashboard";
import * as connectorPolicy from "@zavi/shared";
import { CHANNELS, connectorHasConnectPath } from "@zavi/shared";
import { platformFor } from "./platforms";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  m.composio.mockClear();
});

describe("Email campaigns connect card (the Connect button used to lead nowhere)", () => {
  const linkable = () =>
    (CHANNELS.find((c) => c.slug === "email_marketing")?.connectors ?? []).filter(connectorHasConnectPath);
  const card = (connectors = linkable()) =>
    render(
      <ConnectCard slug="email_marketing" platform={platformFor("email_marketing")} connectors={connectors} onConnect={connectFirst(connectors)} />,
    );

  it("offers Mailchimp, Klaviyo, Gmail and SendGrid, each with its own working button", async () => {
    expect(linkable()).toEqual(["composio.mailchimp", "composio.klaviyo", "composio.gmail", "email"]);
    card();
    expect(screen.getByTestId("connect-card").textContent).toContain("Connect Mailchimp or Klaviyo or Gmail or SendGrid");
    expect(screen.getByRole("button", { name: "Connect SendGrid" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Mailchimp" }));
    await waitFor(() => expect(m.composio).toHaveBeenCalledWith("mailchimp"));
    fireEvent.click(screen.getByRole("button", { name: "Connect Klaviyo" }));
    await waitFor(() => expect(m.composio).toHaveBeenCalledWith("klaviyo"));
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(m.composio).toHaveBeenCalledWith("gmail"));
    expect(m.composio).toHaveBeenCalledTimes(3);
  });

  it("says unconnected emails are drafts, what each connection adds, and never promises it reads numbers", () => {
    card();
    const text = screen.getByTestId("connect-card").textContent ?? "";
    expect(text).toMatch(/Connect SendGrid, Mailchimp or Klaviyo and Zavi sends to a list there once you approve/);
    expect(text).toMatch(/let Zavi send it for you: verify your domain and add a contact list/);
    expect(text).toMatch(/copy each draft and send it from your own tool/);
    expect(text).not.toMatch(/real numbers/);
  });

  it("shows why when a connection cannot start, instead of doing nothing", async () => {
    m.composio.mockRejectedValueOnce(new Error("Composio is not configured"));
    card();
    fireEvent.click(screen.getByRole("button", { name: "Connect Klaviyo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Composio is not configured");
  });
});

describe("a channel already connected through one account still offers the others", () => {
  const declared = () => (CHANNELS.find((c) => c.slug === "email_marketing")?.connectors ?? []).filter(connectorHasConnectPath);
  const also = (linked: string[]) =>
    render(<AlsoConnect platform={platformFor("email_marketing")} connectors={declared()} linked={linked} />);

  it("a Gmail-only workspace is offered Connect Mailchimp and Connect Klaviyo, and both work", async () => {
    also(["composio.gmail"]);
    const row = screen.getByTestId("also-connect");
    expect(row.textContent).toContain("You can also connect Mailchimp or Klaviyo");
    expect(within(row).queryByRole("button", { name: "Connect Gmail" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Connect Mailchimp" }));
    await waitFor(() => expect(m.composio).toHaveBeenCalledWith("mailchimp"));
    fireEvent.click(within(row).getByRole("button", { name: "Connect Klaviyo" }));
    await waitFor(() => expect(m.composio).toHaveBeenCalledWith("klaviyo"));
  });

  it("a workspace connected only through its SendGrid key is offered the other three", () => {
    also(["email"]);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Connect Mailchimp", "Connect Klaviyo", "Connect Gmail"]);
  });

  it("with Mailchimp connected, Klaviyo and Gmail are still on offer", () => {
    also(["composio.mailchimp"]);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Connect Klaviyo", "Connect Gmail", "Connect SendGrid"]);
  });

  it("draws nothing once everything is connected", () => {
    also(["composio.mailchimp", "composio.klaviyo", "composio.gmail", "email"]);
    expect(screen.queryByTestId("also-connect")).toBeNull();
  });

  it("works for any channel that declares several accounts, from its declared list alone", () => {
    expect(connectable(["google_analytics", "google_search_console"], ["google_search_console"])).toEqual(["google_analytics"]);
    expect(connectable(["instagram_social", "composio.instagram"], ["composio.instagram"])).toEqual([]);
    expect(connectable(["instagram_social", "composio.instagram"])).toEqual(["instagram_social"]);
    expect(connectable(["apple_ads", "composio.gmail"])).toEqual(["apple_ads", "composio.gmail"]);
    expect(connectable(["email", "composio.gmail"])).toEqual(["email", "composio.gmail"]);
    expect(connectable(undefined)).toEqual([]);
  });
});

describe("ConnectCard on a channel with no connect of its own", () => {
  it("names the connector and starts the flow from onConnect", async () => {
    const onConnect = vi.fn(async () => {});
    render(
      <ConnectCard slug="tiktok_ads" platform={{ name: "TikTok Ads" }} connectors={["tiktok_ads"]} onConnect={onConnect} />,
    );
    expect(screen.getByTestId("connect-card").textContent).toContain("Connect TikTok Ads");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
  });

  it("puts Connect on its own row under the text, aligned to the right edge", () => {
    render(<ConnectCard slug="tiktok_ads" platform={{ name: "TikTok Ads" }} connectors={["tiktok_ads"]} onConnect={vi.fn(async () => {})} />);
    const button = screen.getByTestId("connect-primary");
    const row = button.parentElement!;
    expect(row.className).toMatch(/(^|\s)justify-end(\s|$)/);
    expect(row.children).toHaveLength(1);
    const stack = row.parentElement!;
    expect(stack.className).toMatch(/(^|\s)flex-col(\s|$)/);
    expect(stack.lastElementChild).toBe(row);
    expect(stack.firstElementChild!.textContent).toContain("Connect TikTok Ads");
    expect(button.className).toContain("text-[14px]");
  });

  it("shows the error when the flow cannot start, instead of doing nothing", async () => {
    render(
      <ConnectCard
        slug="tiktok_ads"
        platform={{ name: "TikTok Ads" }}
        onConnect={async () => {
          throw new Error("Composio is not configured");
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Composio is not configured");
  });

  it("names a connector once when a channel declares its native and Composio rows", () => {
    expect(connectorNames(["tiktok_ads", "composio.tiktok_ads"])).toBe("TikTok Ads");
  });
});

describe("a connector Zavi has no way to connect gets no dead button", () => {
  it("connectFirst launches registered flows and respects the connect-path policy", () => {
    expect(typeof connectFirst(["email"])).toBe("function");
    expect(typeof connectFirst(["apple_ads"])).toBe("function");
    vi.spyOn(connectorPolicy, "hasConnectPath").mockReturnValueOnce(false);
    expect(connectFirst(["unknown_connector"])).toBeUndefined();
    expect(typeof connectFirst(["tiktok_ads"])).toBe("function");
    expect(typeof connectFirst(["composio.pinterest"])).toBe("function");
    expect(typeof connectFirst(["google_search_console"])).toBe("function");
  });

  it("a channel whose only connector has no connect path shows nothing, not a Connect that goes nowhere", () => {
    vi.spyOn(connectorPolicy, "hasConnectPath").mockReturnValue(false);
    render(
      <ConnectCard slug="email_marketing" platform={{ name: "Email campaigns" }} connectors={["unknown_connector"]} onConnect={connectFirst(["unknown_connector"])} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("connect-card")).toBeNull();
    expect(screen.queryByTestId("connect-note")).toBeNull();
    expect(screen.queryByText(/Numbers stay empty/)).toBeNull();
  });

  it("a channel with its own connect keeps the card even when no onConnect is passed", async () => {
    const connect = vi.fn(async () => {});
    render(<ConnectCard slug="x_organic" platform={{ name: "X", connect }} connectors={["x"]} />);
    expect(screen.queryByTestId("connect-note")).toBeNull();
    fireEvent.click(within(screen.getByTestId("connect-card")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  });
});
