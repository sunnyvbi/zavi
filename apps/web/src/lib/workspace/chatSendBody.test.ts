import { describe, it, expect } from "vitest";
import { buildChatSendBody, pageOriginExtras } from "./chatSendBody";

describe("buildChatSendBody — preview_session_id wiring (ELP slice 4b)", () => {
  it("carries preview_session_id when a preview session is open", () => {
    const body = buildChatSendBody("fix the header", "t1", {
      preview_session_id: "11111111-2222-3333-4444-555555555555",
    });
    expect(body).toEqual({
      message: "fix the header",
      thread_id: "t1",
      preview_session_id: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("omits preview_session_id entirely when no session is open (no empty key)", () => {
    const body = buildChatSendBody("fix the header", "t1", {});
    expect(body).not.toHaveProperty("preview_session_id");
    expect(body).toEqual({ message: "fix the header", thread_id: "t1" });
  });

  it("omits preview_session_id when extras is undefined (bare text turn, unchanged)", () => {
    const body = buildChatSendBody("hello", null);
    expect(body).not.toHaveProperty("preview_session_id");
    expect(body).toEqual({ message: "hello", thread_id: null });
  });

  it("attaches preview_session_id alongside image_paths without disturbing them", () => {
    const body = buildChatSendBody("look at this", "t2", {
      image_paths: ["a.png"],
      preview_session_id: "66666666-7777-8888-9999-000000000000",
    });
    expect(body).toEqual({
      message: "look at this",
      thread_id: "t2",
      image_paths: ["a.png"],
      preview_session_id: "66666666-7777-8888-9999-000000000000",
    });
  });

  it("preserves the existing extras shape (command_slug / doc_paths / depth) unchanged", () => {
    const body = buildChatSendBody("m", "t3", {
      command_slug: "foo",
      doc_paths: ["d.pdf"],
      depth: "deep",
    });
    expect(body).toEqual({
      message: "m",
      thread_id: "t3",
      command_slug: "foo",
      doc_paths: ["d.pdf"],
      depth: "deep",
    });
    expect(body).not.toHaveProperty("preview_session_id");
  });
});

describe("buildChatSendBody — video_paths", () => {
  it("carries the attached video path to the backend", () => {
    const body = buildChatSendBody("post this on my tiktok", "t4", {
      video_paths: ["tenant/video.mp4"],
    });
    expect(body).toEqual({
      message: "post this on my tiktok",
      thread_id: "t4",
      video_paths: ["tenant/video.mp4"],
    });
  });

  it("carries a video-only turn (empty message) with its path", () => {
    const body = buildChatSendBody("", null, { video_paths: ["tenant/video.mp4"] });
    expect(body).toEqual({ message: "", thread_id: null, video_paths: ["tenant/video.mp4"] });
  });

  it("omits the key when there is no video", () => {
    expect(buildChatSendBody("hi", null, { video_paths: [] })).not.toHaveProperty("video_paths");
  });
});

describe("buildChatSendBody — channels wiring (#15)", () => {
  it("carries the picked channels", () => {
    const body = buildChatSendBody("plan a week of posts", "t1", {
      channels: ["x", "instagram"],
    });
    expect(body).toEqual({
      message: "plan a week of posts",
      thread_id: "t1",
      channels: ["x", "instagram"],
    });
  });

  it("omits channels entirely when nothing is selected", () => {
    expect(buildChatSendBody("hi", "t1", { channels: [] })).toEqual({
      message: "hi",
      thread_id: "t1",
    });
    expect(buildChatSendBody("hi", "t1", {})).not.toHaveProperty("channels");
    expect(buildChatSendBody("hi", "t1")).not.toHaveProperty("channels");
  });

  it("rides alongside the other extras rather than replacing them", () => {
    const body = buildChatSendBody("look at this", "t1", {
      channels: ["meta_ads"],
      doc_paths: ["a/b.pdf"],
      depth: "deep",
    });
    expect(body.channels).toEqual(["meta_ads"]);
    expect(body.doc_paths).toEqual(["a/b.pdf"]);
    expect(body.depth).toBe("deep");
  });
});

describe("buildChatSendBody — the Build view's app (QA B6)", () => {
  it("carries build_session_id only when the Build chat names one", () => {
    const id = "aaaaaaaa-0000-4000-8000-00000000000a";
    expect(buildChatSendBody("change the headline", "t1", { build_session_id: id }).build_session_id).toBe(id);
    expect(buildChatSendBody("hi", "t1", {})).not.toHaveProperty("build_session_id");
    expect(buildChatSendBody("hi", "t1")).not.toHaveProperty("build_session_id");
  });
});

describe("buildChatSendBody — the card a channel action chat is about", () => {
  it("carries channel_action_id only when the panel names a card, next to its channel", () => {
    const id = "d6cb1532-ead6-4c1c-a258-0c05c9b2d877";
    const body = buildChatSendBody("explain", "t1", { channels: ["meta_ads"], channel_action_id: id });
    expect(body.channel_action_id).toBe(id);
    expect(body.channels).toEqual(["meta_ads"]);
    expect(buildChatSendBody("hi", "t1", {})).not.toHaveProperty("channel_action_id");
    expect(buildChatSendBody("hi", "t1")).not.toHaveProperty("channel_action_id");
  });
});

describe("staff ?model= (spec 2026-10-09)", () => {
  it("attaches model only when present", () => {
    expect(buildChatSendBody("hi", "t1", { model: "qwen" })).toMatchObject({ model: "qwen" });
    expect(buildChatSendBody("hi", "t1", {})).not.toHaveProperty("model");
    expect(buildChatSendBody("hi", "t1")).not.toHaveProperty("model");
  });
});

describe("channel page Past chats: page_channel", () => {
  it("rides only when set, with the card only alongside it", () => {
    const card = "d6cb1532-ead6-4c1c-a258-0c05c9b2d877";
    expect(buildChatSendBody("hi", null, { page_channel: "chatgpt_ads" })).toMatchObject({
      page_channel: "chatgpt_ads",
    });
    expect(
      buildChatSendBody("hi", "t1", { page_channel: "chatgpt_ads", page_channel_action_id: card }),
    ).toMatchObject({ page_channel: "chatgpt_ads", page_channel_action_id: card });
    expect(buildChatSendBody("hi", "t1", { page_channel_action_id: card })).not.toHaveProperty(
      "page_channel_action_id",
    );
    expect(buildChatSendBody("hi", "t1", {})).not.toHaveProperty("page_channel");
    expect(buildChatSendBody("hi", "t1")).not.toHaveProperty("page_channel");
  });
});

describe("pageOriginExtras", () => {
  it("is empty off a channel page and carries the card only with the page", () => {
    expect(pageOriginExtras(undefined, "card")).toEqual({});
    expect(pageOriginExtras("meta_ads", null)).toEqual({ page_channel: "meta_ads" });
    expect(pageOriginExtras("meta_ads", "card")).toEqual({
      page_channel: "meta_ads",
      page_channel_action_id: "card",
    });
  });
});

describe("message_origin", () => {
  it("rides only when the app wrote the message", () => {
    expect(buildChatSendBody("hi", null, { message_origin: "app_action" })).toMatchObject({
      message_origin: "app_action",
    });
    expect(buildChatSendBody("hi", null, {})).not.toHaveProperty("message_origin");
  });
});
