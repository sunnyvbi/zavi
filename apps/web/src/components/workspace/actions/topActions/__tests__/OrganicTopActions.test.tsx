// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ start: vi.fn(), context: vi.fn(), fetch: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionContext: api.context,
}));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));
const pop = vi.hoisted(() => ({ add: vi.fn(), follow: vi.fn() }));
vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: pop.add, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));
vi.mock("../postToast", () => ({ followPostInToast: pop.follow }));

import { TopActionsRow } from "../TopActionsRow";
import { imageFileProblem, isSubreddit } from "../fields";
import { registerChannelScan } from "../../../layout/channelScanHandle";
import { instagram_organic } from "../../platforms/instagram_organic";
import { tiktok_organic } from "../../platforms/tiktok_organic";
import { x_organic } from "../../platforms/x_organic";
import { linkedin_organic } from "../../platforms/linkedin_organic";
import { reddit_organic } from "../../platforms/reddit_organic";
import { pinterest_organic } from "../../platforms/pinterest_organic";
import { youtube_organic } from "../../platforms/youtube_organic";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const IMAGE = `${TENANT}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
const VIDEO = `${TENANT}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4`;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const calls = (path: string) => api.fetch.mock.calls.filter(([u]) => u === path);

beforeEach(() => {
  pop.add.mockReset();
  pop.follow.mockReset().mockResolvedValue({ state: "posted", url: null });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.start.mockReset().mockResolvedValue({ run_id: "run-1" });
  api.context.mockReset().mockResolvedValue({});
  api.fetch.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
    if (url === "/api/chat/upload-video") return ok({ video_path: VIDEO });
    if (url === "/api/social/propose") return ok({ ok: true, decision_id: "d1" });
    if (url === "/api/channels/tiktok_organic/drafts") return ok({ ok: true, publish_id: "p1" });
    return ok({});
  });
});
afterEach(() => cleanup());

const labels = (actions: typeof x_organic.topActions) => (actions ?? []).map((a) => a.label);
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const upload = async (label: string, file: File) => {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
  });
};
const jpg = () => new File(["x"], "photo.jpg", { type: "image/jpeg" });

describe("organic rows", () => {
  it("carry the approved buttons, primary first", () => {
    expect(labels(instagram_organic.topActions)).toEqual(["Post an image", "Draft a Reel", "Rewrite my bio"]);
    expect(labels(tiktok_organic.topActions)).toEqual(["Write a video script", "Send video to TikTok drafts"]);
    expect(labels(x_organic.topActions)).toEqual(["New post", "New thread", "Post with image"]);
    expect(labels(linkedin_organic.topActions)).toEqual(["New post", "Post with image", "Draft comment"]);
    expect(labels(reddit_organic.topActions)).toEqual(["Find threads", "Draft a post", "Add a subreddit"]);
    expect(labels(pinterest_organic.topActions)).toEqual(["Create a pin"]);
    expect(labels(youtube_organic.topActions)).toEqual(["Plan a video"]);
  });

  it("check files and names before sending", () => {
    expect(imageFileProblem({ type: "image/gif", size: 10 })).toMatch(/JPG, PNG or WebP/);
    expect(imageFileProblem({ type: "image/png", size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(imageFileProblem({ type: "image/webp", size: 10 })).toBeNull();
    expect(isSubreddit("r/smallbusiness")).toBe(true);
    expect(isSubreddit("https://www.reddit.com/r/smallbusiness/")).toBe(true);
    expect(isSubreddit("not a sub!")).toBe(false);
  });
});

describe("posting an upload stages it for approval", () => {
  it("Instagram: the image and caption go to /api/social/propose as instagram_image, never straight out", async () => {
    render(<TopActionsRow slug="instagram_organic" channelName="Instagram" actions={instagram_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Post an image" }));
    expect(api.context).not.toHaveBeenCalled();
    const send = screen.getByRole("button", { name: "Send for approval" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await upload("Upload an image", jpg());
    fireEvent.change(screen.getByLabelText("Caption (optional)"), { target: { value: "Fall weekend, 20% off" } });
    const staged = vi.fn();
    window.addEventListener("zavi:approvals-changed", staged);
    await press("Send for approval");
    window.removeEventListener("zavi:approvals-changed", staged);
    expect(staged).toHaveBeenCalledTimes(1);
    const [[, init]] = calls("/api/social/propose");
    expect(JSON.parse(String(init.body))).toEqual({ channel: "instagram_image", payload: { image_path: IMAGE, text: "Fall weekend, 20% off" } });
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.getByText(/waiting for your approval on this page/)).toBeTruthy();
  });

  it("Pinterest: the pin goes out with the board the founder picked and the link", async () => {
    api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
    render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
    await act(async () => {});
    expect(api.context).toHaveBeenCalledWith("pinterest_organic", "create_pin");
    await upload("Upload an image", jpg());
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Autumn table ideas" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Five easy setups." } });
    fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://example.com/autumn" } });
    await press("Post");
    const [[, init]] = calls("/api/social/propose");
    expect(JSON.parse(String(init.body))).toEqual({
      channel: "pinterest_pin",
      payload: { image_path: IMAGE, title: "Autumn table ideas", text: "Five easy setups.", board_id: "77", link: "https://example.com/autumn" },
    });
  });

  it("Pinterest: a failed board lookup says Zavi couldn't load the boards, never that there are none", async () => {
    api.context.mockResolvedValue({ boards: [], boards_error: true });
    render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
    await act(async () => {});
    expect(screen.getByText("Zavi couldn't load your Pinterest boards. Try again in a minute.")).toBeTruthy();
    expect(screen.queryByText(/No public board found/)).toBeNull();
  });

  it("Pinterest: an account with no public board still gets the connect-or-create hint", async () => {
    api.context.mockResolvedValue({ boards: [] });
    render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
    await act(async () => {});
    expect(screen.getByText(/No public board found/)).toBeTruthy();
  });

  it("Pinterest: a partial board list says some boards may be missing and still offers the ones it has", async () => {
    api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }], boards_partial: true });
    render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
    await act(async () => {});
    expect(screen.getByText(/some boards may be missing/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Ideas" })).toBeTruthy();
  });

  describe("Pinterest: boards made or found from the picker", () => {
    const open = async () => {
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
    };
    const board = (sel = "Board") => (screen.getByLabelText(sel) as HTMLSelectElement).value;

    it("New board makes a public board, picks it even when the reload has not caught up, and the pin goes on it", async () => {
      api.context.mockResolvedValueOnce({ boards: [] }).mockResolvedValueOnce({ boards: [{ id: "77", label: "Ideas" }] });
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/channels/pinterest_organic/boards") return ok({ board: { id: "9001", label: "Autumn" } });
        if (url === "/api/social/propose") return ok({ ok: true, decision_id: "d1" });
        return ok({});
      });
      await open();
      expect((screen.getByLabelText("Board") as HTMLSelectElement).disabled).toBe(true);
      await press("New board");
      fireEvent.change(screen.getByLabelText("Board name"), { target: { value: " Autumn " } });
      fireEvent.change(screen.getByLabelText("Board description (optional)"), { target: { value: "Tables" } });
      await press("Make board");
      await act(async () => {});
      const posts = calls("/api/channels/pinterest_organic/boards");
      expect(posts).toHaveLength(1);
      expect(posts[0][1].method).toBe("POST");
      expect(JSON.parse(String(posts[0][1].body))).toEqual({ name: "Autumn", description: "Tables" });
      expect(api.context).toHaveBeenCalledTimes(2);
      expect(board()).toBe("9001");
      expect(screen.getByRole("option", { name: "Autumn" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Ideas" })).toBeTruthy();
      await upload("Upload an image", jpg());
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Autumn table ideas" } });
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://example.com/autumn" } });
      await press("Send for approval");
      expect(api.start).toHaveBeenCalledWith("pinterest_organic", "create_pin_write", expect.any(String), expect.objectContaining({ board_id: "9001" }));
    });

    it("a name Pinterest already has says so, picks nothing and reloads nothing", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
      api.fetch.mockImplementation(async (url: string) =>
        url === "/api/channels/pinterest_organic/boards"
          ? { ok: false, status: 409, json: async () => ({ error: { code: "name_taken", message: "You already have a board with that name. Pick it from the list, or use a different name." } }) }
          : ok({}),
      );
      await open();
      await press("New board");
      fireEvent.change(screen.getByLabelText("Board name"), { target: { value: "Ideas" } });
      await press("Make board");
      expect(screen.getByRole("alert").textContent).toMatch(/already have a board with that name/);
      expect(board()).toBe("");
      expect(api.context).toHaveBeenCalledTimes(1);
    });

    it("offers no New board while Pinterest is not connected", async () => {
      api.context.mockResolvedValue({ boards: [], connected: false });
      await open();
      expect(screen.queryByRole("button", { name: "New board" })).toBeNull();
      expect(screen.getByText("Connect Pinterest in Integrations first, then pick or make a public board.")).toBeTruthy();
      expect(screen.queryByText(/New board/)).toBeNull();
    });

    it("a partial list lets the founder find a missing board by name and picks it", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }], boards_partial: true });
      api.fetch.mockImplementation(async (url: string) =>
        url.startsWith("/api/channels/pinterest_organic/boards/search") ? ok({ boards: [{ id: "4242", label: "Linen bedding" }] }) : ok({}),
      );
      await open();
      fireEvent.change(screen.getByLabelText("Find a board by name"), { target: { value: " linen " } });
      await press("Search");
      const searched = api.fetch.mock.calls.filter(([u]) => String(u).startsWith("/api/channels/pinterest_organic/boards/search"));
      expect(searched.map(([u]) => u)).toEqual(["/api/channels/pinterest_organic/boards/search?q=linen"]);
      expect(board()).toBe("4242");
      expect(screen.getByRole("option", { name: "Ideas" })).toBeTruthy();
    });

    it("a failed search says so and never empties the list", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }], boards_partial: true });
      api.fetch.mockImplementation(async (url: string) =>
        url.startsWith("/api/channels/pinterest_organic/boards/search")
          ? { ok: false, status: 502, json: async () => ({ error: { message: "Zavi could not search your Pinterest boards just now. Try again in a minute." } }) }
          : ok({}),
      );
      await open();
      fireEvent.change(screen.getByLabelText("Find a board by name"), { target: { value: "linen" } });
      await press("Search");
      expect(screen.getByText(/could not search your Pinterest boards/)).toBeTruthy();
      expect(screen.getByRole("option", { name: "Ideas" })).toBeTruthy();
      expect(board()).toBe("");
    });

    it("a complete list shows no search box", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
      await open();
      expect(screen.queryByLabelText("Find a board by name")).toBeNull();
      expect(screen.getByRole("button", { name: "New board" })).toBeTruthy();
    });
  });

  describe("Pinterest: a pin the founder wrote posts on the press", () => {
    const fillOwnPin = async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      await upload("Upload an image", jpg());
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Birthday cakes" } });
      fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Made to order." } });
      fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://cakely.example/b" } });
    };
    const order = () => api.fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/social/propose") || u.includes("/approve"));

    it("stages the pin, approves exactly that decision to publish now, closes the dialog and follows the post in a popup", async () => {
      await fillOwnPin();
      expect(screen.getByText(/Post sends it to your connected Pinterest account now/)).toBeTruthy();
      await press("Post");
      expect(order()).toEqual(["/api/social/propose", "/api/approvals/d1/approve"]);
      const [, init] = api.fetch.mock.calls.find(([u]) => String(u) === "/api/approvals/d1/approve")!;
      expect((init as RequestInit).method).toBe("POST");
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ scheduled_at: null });
      expect(pop.follow).toHaveBeenCalledWith("d1", "Pinterest");
      expect(screen.queryByRole("heading", { name: "Create a pin" })).toBeNull();
      expect(screen.queryByText(/Sent to Pinterest/)).toBeNull();
    });

    it("only the pressed button says Loading…, and every button is held while it works", async () => {
      let release: (v: unknown) => void = () => {};
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/social/propose") return new Promise((r) => (release = () => r(ok({ ok: true, decision_id: "d1" }))));
        return ok({});
      });
      await fillOwnPin();
      fireEvent.click(screen.getByRole("button", { name: "Post" }));
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Loading…" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Send for approval" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "Post" })).toBeNull();
      await act(async () => release(null));
    });

    it("pressing Send for approval puts Loading… on that button, not on Post", async () => {
      let release: (v: unknown) => void = () => {};
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/social/propose") return new Promise((r) => (release = () => r(ok({ ok: true, decision_id: "d1" }))));
        return ok({});
      });
      await fillOwnPin();
      fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Loading…" }).getAttribute("aria-busy")).toBe("true");
      expect((screen.getByRole("button", { name: "Post" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole("button", { name: "Send for approval" })).toBeNull();
      await act(async () => release(null));
    });

    it("a refused approve closes the composer, keeps the pin staged, and never offers a duplicate post", async () => {
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/social/propose") return ok({ ok: true, decision_id: "d1" });
        if (url === "/api/approvals/d1/approve") return { ok: false, status: 422, json: async () => ({ error: { message: "Pinterest is not connected." } }) };
        return ok({});
      });
      await fillOwnPin();
      await press("Post");
      expect(pop.add).toHaveBeenCalledWith(expect.objectContaining({
        type: "error",
        title: "Pin saved for approval",
        description: "It was not posted: Pinterest is not connected. Review it on the Pinterest page.",
      }));
      expect(pop.follow).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Create a pin" })).toBeNull();
    });

    it("reuses one proposal idempotency key when an unchanged submission is retried", async () => {
      let proposals = 0;
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/social/propose") {
          proposals += 1;
          if (proposals === 1) throw new TypeError("response lost");
          return ok({ ok: true, decision_id: "d1" });
        }
        if (url === "/api/approvals/d1/approve") return ok({ ok: true });
        return ok({});
      });
      await fillOwnPin();
      await press("Post");
      expect(screen.getByRole("alert")).toBeTruthy();
      await press("Post");

      const proposalCalls = calls("/api/social/propose");
      expect(proposalCalls).toHaveLength(2);
      expect(new Headers(proposalCalls[0][1].headers).get("Idempotency-Key")).toBeTruthy();
      expect(new Headers(proposalCalls[1][1].headers).get("Idempotency-Key")).toBe(
        new Headers(proposalCalls[0][1].headers).get("Idempotency-Key"),
      );
    });

    it("treats an HTTP 500 approval reply as ambiguous and follows the original pin", async () => {
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/social/propose") return ok({ ok: true, decision_id: "d1" });
        if (url === "/api/approvals/d1/approve") return { ok: false, status: 500, json: async () => ({ error: { message: "event unavailable" } }) };
        return ok({});
      });
      await fillOwnPin();
      await press("Post");

      expect(pop.follow).toHaveBeenCalledWith("d1", "Pinterest");
      expect(screen.queryByRole("heading", { name: "Create a pin" })).toBeNull();
    });

    it("an ambiguous approve response closes the composer and follows the original decision instead of offering a duplicate", async () => {
      api.fetch.mockImplementation(async (url: string) => {
        if (url === "/api/chat/upload-image") return ok({ image_path: IMAGE });
        if (url === "/api/social/propose") return ok({ ok: true, decision_id: "d1" });
        if (url === "/api/approvals/d1/approve") throw new TypeError("network lost after send");
        return ok({});
      });
      await fillOwnPin();

      await press("Post");

      expect(calls("/api/social/propose")).toHaveLength(1);
      expect(pop.follow).toHaveBeenCalledWith("d1", "Pinterest");
      expect(pop.add).toHaveBeenCalledWith(expect.objectContaining({
        type: "info",
        title: "Could not confirm the approval",
      }));
      expect(screen.queryByRole("heading", { name: "Create a pin" })).toBeNull();
    });

    it("three buttons: Cancel, Send for approval and Post; Post is off until the founder writes the words", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      const dialog = document.querySelector("dialog")!;
      const footer = [...dialog.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter((t) => t === "Cancel" || t === "Send for approval" || t === "Post");
      expect(footer).toEqual(["Cancel", "Send for approval", "Post"]);
      await upload("Upload an image", jpg());
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Birthday cakes" } });
      fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://cakely.example/b" } });
      const post = screen.getByRole("button", { name: "Post" }) as HTMLButtonElement;
      expect(post.disabled).toBe(true);
      expect(post.title).toMatch(/Write a description to post now/);
      expect((screen.getByRole("button", { name: "Send for approval" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Mine" } });
      expect((screen.getByRole("button", { name: "Post" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("Send for approval with the founder's words stages the pin and approves nothing", async () => {
      await fillOwnPin();
      await press("Send for approval");
      expect(order()).toEqual(["/api/social/propose"]);
      expect(calls("/api/social/propose")[0][1]).toMatchObject({ idempotent: true });
      expect(pop.add).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Sent for approval" }));
      expect(pop.follow).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Create a pin" })).toBeNull();
    });

    it("Send for approval with the words left empty starts Zavi's write run and approves nothing", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      await upload("Upload an image", jpg());
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Birthday cakes" } });
      fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://cakely.example/b" } });
      await press("Send for approval");
      expect(api.start).toHaveBeenCalledWith("pinterest_organic", "create_pin_write", expect.any(String), expect.any(Object));
      expect(order()).toEqual([]);
    });

    it("other channels are untouched: Instagram's post is staged and never approved by the form", async () => {
      render(<TopActionsRow slug="instagram_organic" channelName="Instagram" actions={instagram_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Post an image" }));
      await upload("Upload an image", jpg());
      fireEvent.change(screen.getByLabelText("Caption (optional)"), { target: { value: "Fall weekend" } });
      await press("Send for approval");
      expect(order()).toEqual(["/api/social/propose"]);
    });
  });

  describe("an uploaded image shows a preview", () => {
    let n = 0;
    const revoke = vi.fn();
    beforeEach(() => {
      n = 0;
      revoke.mockReset();
      URL.createObjectURL = vi.fn(() => `blob:preview-${(n += 1)}`);
      URL.revokeObjectURL = revoke;
    });

    it("shows the picked image after the upload lands, and frees the old preview when the image is replaced", async () => {
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      expect(screen.queryByRole("img", { name: /Preview of/ })).toBeNull();
      await upload("Upload an image", jpg());
      expect((screen.getByRole("img", { name: "Preview of photo.jpg" }) as HTMLImageElement).src).toBe("blob:preview-1");
      await upload("Upload an image", new File(["y"], "second.png", { type: "image/png" }));
      expect((screen.getByRole("img", { name: "Preview of second.png" }) as HTMLImageElement).src).toBe("blob:preview-2");
      expect(revoke).toHaveBeenCalledWith("blob:preview-1");
    });

    it("shows no preview when the upload fails", async () => {
      api.fetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      await upload("Upload an image", jpg());
      expect(screen.queryByRole("img", { name: /Preview of/ })).toBeNull();
      expect(screen.getByRole("alert").textContent).toMatch(/did not finish/);
    });

    it("clears the old image when a replacement upload fails", async () => {
      let uploads = 0;
      api.fetch.mockImplementation(async (url: string) => {
        if (url !== "/api/chat/upload-image") return ok({});
        uploads += 1;
        return uploads === 1 ? ok({ image_path: IMAGE }) : { ok: false, status: 500, json: async () => ({}) };
      });
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      await upload("Upload an image", jpg());
      expect(screen.getByRole("img", { name: "Preview of photo.jpg" })).toBeTruthy();

      await upload("Upload an image", new File(["y"], "replacement.png", { type: "image/png" }));

      expect(screen.queryByRole("img", { name: /Preview of/ })).toBeNull();
      expect((screen.getByRole("button", { name: "Send for approval" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("alert").textContent).toMatch(/did not finish/);
    });
  });

  describe("Pinterest link defaults to the published website", () => {
    const SITE = "https://cakely-d3560e3b.zaviagent.com";
    const openPin = async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }], site_url: SITE });
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      await upload("Upload an image", jpg());
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Birthday cakes" } });
      fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Made to order." } });
      fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
    };
    const sentLink = () => (JSON.parse(String(calls("/api/social/propose")[0][1].body)) as { payload: { link: string } }).payload.link;

    it("shows the published site instead of an empty box, and the pin goes out with it untouched", async () => {
      await openPin();
      expect(screen.getByTestId("top-action-link-site").textContent).toBe(SITE);
      expect(screen.queryByLabelText("Link")).toBeNull();
      await press("Post");
      expect(sentLink()).toBe(SITE);
    });

    it("Use a different link opens an empty box, refuses a non-https link, and sends the typed one", async () => {
      await openPin();
      fireEvent.click(screen.getByRole("button", { name: "Use a different link" }));
      const box = screen.getByLabelText("Link") as HTMLInputElement;
      expect(box.value).toBe("");
      fireEvent.change(box, { target: { value: "http://www.upcar.ai/" } });
      fireEvent.blur(box);
      expect(screen.getByText(/starts with https:\/\//)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Post" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(box, { target: { value: "https://cakely.com/birthday" } });
      await press("Post");
      expect(sentLink()).toBe("https://cakely.com/birthday");
    });

    it("Use my website puts the published site back after a custom link was typed", async () => {
      await openPin();
      fireEvent.click(screen.getByRole("button", { name: "Use a different link" }));
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://other.example/x" } });
      fireEvent.click(screen.getByRole("button", { name: "Use my website" }));
      expect(screen.getByTestId("top-action-link-site").textContent).toBe(SITE);
      await press("Post");
      expect(sentLink()).toBe(SITE);
    });

    it("a site that is not https is never offered; the founder types the link as before", async () => {
      api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }], site_url: "http://cakely.example" });
      render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
      await act(async () => {});
      expect(screen.queryByTestId("top-action-link-site")).toBeNull();
      expect((screen.getByLabelText("Link") as HTMLInputElement).value).toBe("");
    });
  });

  it("a refusal stays in the modal with the server's reason", async () => {
    api.fetch.mockImplementation(async (url: string) =>
      url === "/api/chat/upload-image" ? ok({ image_path: IMAGE }) : { ok: false, status: 422, json: async () => ({ error: { message: "Zavi could not confirm the Pinterest board." } }) },
    );
    render(<TopActionsRow slug="x_organic" channelName="X" actions={x_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Post with image" }));
    await upload("Upload an image", jpg());
    fireEvent.change(screen.getByLabelText("Post (optional)"), { target: { value: "New this week" } });
    await press("Send for approval");
    expect(screen.getByRole("alert").textContent).toContain("Zavi could not confirm the Pinterest board.");
  });
});

describe("an image post with the words left empty: Zavi writes them", () => {
  it("Instagram: says Zavi writes an empty caption, starts the write run with the image only, and stages nothing itself", async () => {
    const onStarted = vi.fn();
    render(<TopActionsRow slug="instagram_organic" channelName="Instagram" actions={instagram_organic.topActions} onChanged={() => {}} onStarted={onStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Post an image" }));
    expect((screen.getByLabelText("Caption (optional)") as HTMLTextAreaElement).placeholder).toBe("Leave empty and Zavi writes it");
    await upload("Upload an image", jpg());
    fireEvent.change(screen.getByLabelText("Caption (optional)"), { target: { value: "   " } });
    await press("Send for approval");
    expect(api.start).toHaveBeenCalledWith("instagram_organic", "post_image_write", expect.any(String), { image_path: IMAGE });
    expect(calls("/api/social/propose")).toHaveLength(0);
    expect(onStarted).toHaveBeenCalled();
    expect(screen.getByText(/Zavi is writing the caption/)).toBeTruthy();
    expect(screen.queryByText(/It posts to Instagram when you approve/)).toBeNull();
  });

  it("X and LinkedIn: an empty post goes to the write run, a written one is staged as written", async () => {
    for (const [slug, row] of [["x_organic", x_organic], ["linkedin_organic", linkedin_organic]] as const) {
      api.start.mockClear();
      api.fetch.mockClear();
      render(<TopActionsRow slug={slug} channelName={row.name} actions={row.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Post with image" }));
      await upload("Upload an image", jpg());
      await press("Send for approval");
      expect(api.start).toHaveBeenCalledWith(slug, "post_image_write", expect.any(String), { image_path: IMAGE });
      expect(calls("/api/social/propose")).toHaveLength(0);
      expect(screen.getByText(/Zavi is writing the post/)).toBeTruthy();
      cleanup();
    }
  });

  it("Pinterest: an empty description starts the write run with the founder's image, title, board and link", async () => {
    api.context.mockResolvedValue({ boards: [{ id: "77", label: "Ideas" }] });
    render(<TopActionsRow slug="pinterest_organic" channelName="Pinterest" actions={pinterest_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a pin" }));
    await act(async () => {});
    await upload("Upload an image", jpg());
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Autumn table ideas" } });
    fireEvent.change(screen.getByLabelText("Board"), { target: { value: "77" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://example.com/autumn" } });
    await press("Send for approval");
    expect(api.start).toHaveBeenCalledWith("pinterest_organic", "create_pin_write", expect.any(String), {
      image_path: IMAGE,
      title: "Autumn table ideas",
      board_id: "77",
      link: "https://example.com/autumn",
    });
    expect(calls("/api/social/propose")).toHaveLength(0);
    expect(pop.add).toHaveBeenCalledWith(expect.objectContaining({ title: "Sent for approval", description: expect.stringMatching(/Zavi is writing the description/) }));
    expect(screen.queryByRole("heading", { name: "Create a pin" })).toBeNull();
  });

  it("a refused write run stays in the modal with the reason", async () => {
    api.start.mockRejectedValue(new Error("That file is not in this workspace. Upload it again."));
    render(<TopActionsRow slug="instagram_organic" channelName="Instagram" actions={instagram_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Post an image" }));
    await upload("Upload an image", jpg());
    await press("Send for approval");
    expect(screen.getByRole("alert").textContent).toContain("That file is not in this workspace.");
  });
});

describe("TikTok: Send video to TikTok drafts", () => {
  it("sends the upload only after the consent box, through the idempotent drafts route", async () => {
    render(<TopActionsRow slug="tiktok_organic" channelName="TikTok" actions={tiktok_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send video to TikTok drafts" }));
    expect(screen.getByText("Nothing posts publicly. It goes to your drafts only.")).toBeTruthy();
    expect(screen.queryByText(/Pick a video Zavi made/)).toBeNull();
    await upload("Upload a video", new File(["v"], "clip.mp4", { type: "video/mp4" }));
    const send = screen.getByRole("button", { name: "Send to my TikTok drafts" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(send.disabled).toBe(false);
    await press("Send to my TikTok drafts");
    const [[, init]] = calls("/api/channels/tiktok_organic/drafts");
    expect(JSON.parse(String(init.body))).toEqual({ video_path: VIDEO, consent: true });
    expect(init.idempotent).toBe(true);
    expect(screen.getByText(/Open your TikTok drafts/)).toBeTruthy();
  });
});

describe("Reddit reuses its own controls", () => {
  it("Add a subreddit posts the name to the community route", async () => {
    render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a subreddit" }));
    fireEvent.change(screen.getByLabelText("Subreddit"), { target: { value: "r/smallbusiness" } });
    await press("Add");
    const [[, init]] = calls("/api/reddit/workspace/communities");
    expect(JSON.parse(String(init.body))).toEqual({ name: "r/smallbusiness" });
  });

  it("Find threads presses the page's Scan now, never a second scan path", async () => {
    const scan = vi.fn(async () => null);
    const off = registerChannelScan("reddit_organic", { status: () => ({ canScan: true, running: false, blockedWhy: null, ready: true }), scan });
    render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Find threads" }));
    const inModal = screen.getAllByRole("button", { name: "Find threads" });
    await act(async () => {
      fireEvent.click(inModal[inModal.length - 1]);
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/Looking now/)).toBeTruthy();
    off();
  });

  it("Find threads says why it cannot scan, with the button down", () => {
    const off = registerChannelScan("reddit_organic", {
      status: () => ({ canScan: false, running: false, blockedWhy: "This week's scan budget is used up.", ready: true }),
      scan: vi.fn(),
    });
    render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Find threads" }));
    expect(screen.getByText("This week's scan budget is used up.")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Find threads" }) as HTMLButtonElement[];
    expect(buttons[buttons.length - 1].disabled).toBe(true);
    off();
  });
});

describe("draft buttons start a run", () => {
  it("say what the run holds in credits and send the topic", async () => {
    api.context.mockResolvedValue({ credits: 60 });
    const onStarted = vi.fn();
    render(<TopActionsRow slug="instagram_organic" channelName="Instagram" actions={instagram_organic.topActions} onChanged={() => {}} onStarted={onStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft a Reel" }));
    await act(async () => {});
    expect(screen.getByText("About 60 credits")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Topic (optional)"), { target: { value: "How a booking works" } });
    await press("Draft the Reel");
    expect(api.start).toHaveBeenCalledWith("instagram_organic", "draft_reel", expect.any(String), { topic: "How a booking works" });
    expect(onStarted).toHaveBeenCalled();
  });

  it("send nothing for an empty optional topic", async () => {
    render(<TopActionsRow slug="youtube_organic" channelName="YouTube" actions={youtube_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan a video" }));
    await act(async () => {});
    await press("Plan the video");
    expect(api.start).toHaveBeenCalledWith("youtube_organic", "plan_video", expect.any(String), {});
  });
});

describe("X drafting and text limits", () => {
  it.each([['New post', 'Write the post'], ['New thread', 'Write the thread']])("%s reports a started draft, not a finished card", async (label, primary) => {
    render(<TopActionsRow slug="x_organic" channelName="X" actions={x_organic.topActions} onChanged={() => {}} />);
    await press(label);
    if (label === "New thread") fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "A useful checklist" } });
    await press(primary);
    expect(screen.getByRole("dialog").textContent).toContain("Zavi is writing");
    expect(screen.getByRole("dialog").textContent).toContain("when ready");
  });

  it("keeps a long URL intact and refuses text over X's weighted limit", async () => {
    render(<TopActionsRow slug="x_organic" channelName="X" actions={x_organic.topActions} onChanged={() => {}} />);
    await press("Post with image");
    await upload("Upload an image", jpg());
    const box = screen.getByLabelText("Post (optional)") as HTMLTextAreaElement;
    expect(box.hasAttribute("maxlength")).toBe(false);
    fireEvent.change(box, { target: { value: "界".repeat(141) } });
    fireEvent.blur(box);
    expect(screen.getByRole("button", { name: "Send for approval" })).toHaveProperty("disabled", true);
    const text = "a".repeat(256) + " https://example.com/" + "b".repeat(500);
    fireEvent.change(box, { target: { value: text } });
    await press("Send for approval");
    expect(JSON.parse(String(calls("/api/social/propose")[0][1].body)).payload.text).toBe(text);
  });
});
