// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ start: vi.fn(), context: vi.fn(), campaign: vi.fn(), review: vi.fn(), fetch: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionContext: api.context,
}));
vi.mock("../../managed-campaigns/api", async (orig) => ({ ...(await orig<object>()), campaignFetch: api.campaign }));
vi.mock("../../managed-campaigns/campaignReviewRequest", async (orig) => ({ ...(await orig<object>()), requestCampaignReview: api.review }));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));

import { GOOGLE_CREATE, META_CREATE } from "./createAdSpecs";
import { TopActionsRow } from "../TopActionsRow";
import { FormActionModal } from "../FormActionModal";
import { videoFileProblem } from "../fields";
import { registerNewCampaignOpener } from "../../managed-campaigns/newCampaignRequest";
import { google_ads } from "../../platforms/google_ads";
import { meta_ads } from "../../platforms/meta_ads";
import { youtube_ads } from "../../platforms/youtube_ads";
import { linkedin_ads } from "../../platforms/linkedin_ads";
import { reddit_ads } from "../../platforms/reddit_ads";
import { tiktok_ads } from "../../platforms/tiktok_ads";
import { x_ads } from "../../platforms/x_ads";
import { chatgpt_ads } from "../../platforms/chatgpt_ads";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.start.mockReset().mockResolvedValue({ run_id: "run-1" });
  api.context.mockReset().mockResolvedValue({});
  api.campaign.mockReset();
  api.review.mockReset();
  api.fetch.mockReset().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
});
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
afterEach(() => cleanup());

const labels = (actions: typeof google_ads.topActions) => (actions ?? []).map((a) => a.label);

describe("paid ads rows", () => {
  it("carry the approved buttons, primary first", () => {
    expect(labels(google_ads.topActions)).toEqual(["Create campaign"]);
    expect(labels(meta_ads.topActions)).toEqual(["Create campaign", "Boost a Page post"]);
    expect([google_ads.createMenu, meta_ads.createMenu]).toEqual(["Create", "Create"]);
    expect(labels(youtube_ads.topActions)).toEqual(["Create campaign"]);
    expect(youtube_ads.createMenu).toBe("Create");
    expect(labels(linkedin_ads.topActions)).toEqual(["Boost a Page post"]);
    expect(labels(reddit_ads.topActions)).toEqual(["Create new ad", "Write ad copy"]);
    expect(labels(tiktok_ads.topActions)).toEqual(["New campaign", "Create new ad"]);
    expect(labels(x_ads.topActions)).toEqual(["Promote a post", "Create new ad"]);
    expect(labels(chatgpt_ads.topActions)).toEqual(["Create campaign"]);
  });
});

describe("FormActionModal", () => {
  it("Reddit Write ad copy posts the community to its run and shows the done strip", async () => {
    const onStarted = vi.fn();
    render(<TopActionsRow slug="reddit_ads" channelName="Reddit Ads" actions={reddit_ads.topActions} onChanged={() => {}} onStarted={onStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Write ad copy" }));
    expect(screen.getByRole("dialog", { name: "Write ad copy" })).toBeTruthy();
    expect(api.context).toHaveBeenCalledWith("reddit_ads", "write_ad_copy");
    const write = screen.getByRole("button", { name: "Write 3 ads" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Community"), { target: { value: "r/roadtrip" } });
    await act(async () => {
      fireEvent.click(write);
    });
    expect(api.start).toHaveBeenCalledWith("reddit_ads", "write_ad_copy", expect.any(String), { community: "r/roadtrip" });
    expect(onStarted).toHaveBeenCalled();
    expect(screen.getByText(/The three drafts land in What Zavi wants to do/)).toBeTruthy();
  });

  it("LinkedIn Boost a Page post reuses the campaign-draft route and opens its review", async () => {
    api.campaign.mockResolvedValue({ action_id: "act-9" });
    render(<TopActionsRow slug="linkedin_ads" channelName="LinkedIn Ads" actions={linkedin_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Boost a Page post" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prepare the campaign" }));
    });
    expect(api.campaign).toHaveBeenCalledWith("/api/channels/linkedin_ads/campaign-drafts", { method: "POST", body: "{}" });
    expect(api.start).not.toHaveBeenCalled();
    expect(api.review).toHaveBeenCalledWith("act-9");
    expect(screen.queryByRole("dialog", { name: "Boost a Page post" })).toBeNull();
  });

  it("LinkedIn: a refused draft stays in the modal with the reason", async () => {
    api.campaign.mockRejectedValue(new Error("Choose an account for new campaigns first."));
    render(<TopActionsRow slug="linkedin_ads" channelName="LinkedIn Ads" actions={linkedin_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Boost a Page post" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prepare the campaign" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("Choose an account for new campaigns first.");
    expect(api.review).not.toHaveBeenCalled();
  });
});

describe("ChatGPT Ads reuses its own flows", () => {
  it("Create new ad opens the campaign list's editor", () => {
    const opener = vi.fn();
    const off = registerNewCampaignOpener(opener);
    render(<TopActionsRow slug="chatgpt_ads" channelName="ChatGPT Ads" actions={chatgpt_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(opener).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    off();
  });

  it("Create new ad says why when the campaign list cannot open the editor", () => {
    render(<TopActionsRow slug="chatgpt_ads" channelName="ChatGPT Ads" actions={chatgpt_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(screen.getByRole("dialog", { name: "Create campaign" }).textContent).toContain("cannot create a campaign yet");
  });

  it("draws no balance at the top of the page", () => {
    render(<TopActionsRow slug="chatgpt_ads" channelName="ChatGPT Ads" actions={chatgpt_ads.topActions} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: /Add money|Add ads balance/ })).toBeNull();
  });
});

describe("Include and exclude locations (Google and YouTube)", () => {
  it("include starts at the business's country; both fields search the channel's places and send what was picked", async () => {
    vi.useFakeTimers();
    try {
      api.context.mockResolvedValue({ currency: "USD", places: [{ id: "2840", name: "United States" }] });
      api.start.mockResolvedValue({ run_id: null });
      api.fetch.mockImplementation(async (url: string) =>
        String(url).includes("/ad-locations/search?q=Austin")
          ? ok({ places: [{ id: "1014221", name: "Austin, Texas", kind: "City" }] })
          : String(url).includes("/ad-locations/search?q=Round")
            ? ok({ places: [{ id: "1026339", name: "Round Rock, Texas", kind: "City" }] })
            : ok({}),
      );
      render(<TopActionsRow slug="google_ads" channelName="Google Ads" actions={[GOOGLE_CREATE]} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
      await act(async () => {});
      expect(screen.getByTestId("top-action-places").textContent).toContain("United States");
      fireEvent.change(screen.getByLabelText("Include locations"), { target: { value: "Austin" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.fetch).toHaveBeenCalledWith("/api/channels/google_ads/ad-locations/search?q=Austin");
      fireEvent.click(screen.getByRole("option", { name: /Austin, Texas/ }));
      fireEvent.click(screen.getByRole("button", { name: "Remove United States" }));
      fireEvent.change(screen.getByLabelText("Exclude locations"), { target: { value: "Round" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      fireEvent.click(screen.getByRole("option", { name: /Round Rock, Texas/ }));
      fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "Teslas" } });
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://upcar.ai/h" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
      });
      expect(api.start.mock.calls[0][3]).toEqual({
        about: "Teslas",
        link: "https://upcar.ai/h",
        goal: "visit",
        daily_budget: 20,
        places: [{ id: "1014221", name: "Austin, Texas" }],
        excluded_places: [{ id: "1026339", name: "Round Rock, Texas" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Meta's locations start empty, are optional, and send Meta's own place ids", async () => {
    vi.useFakeTimers();
    try {
      api.context.mockResolvedValue({ currency: "USD" });
      api.fetch.mockImplementation(async (url: string) =>
        String(url).includes("/ad-locations/search?q=Texas")
          ? ok({ places: [{ id: "region:3886", name: "Texas, United States", kind: "State" }] })
          : String(url).includes("/ad-locations/search?q=Dallas")
            ? ok({ places: [{ id: "city:2418956", name: "Dallas, Texas", kind: "City" }] })
            : ok({}),
      );
      render(<TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={[META_CREATE]} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
      await act(async () => {});
      expect(screen.queryByTestId("top-action-places")).toBeNull();
      fireEvent.change(screen.getByLabelText("Include locations"), { target: { value: "Texas" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.fetch).toHaveBeenCalledWith("/api/channels/meta_ads/ad-locations/search?q=Texas");
      fireEvent.click(screen.getByRole("option", { name: /Texas, United States/ }));
      fireEvent.change(screen.getByLabelText("Exclude locations"), { target: { value: "Dallas" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      fireEvent.click(screen.getByRole("option", { name: /Dallas, Texas/ }));
      fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "Teslas" } });
      fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://upcar.ai/h" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
      });
      expect(api.start.mock.calls[0][3]).toMatchObject({
        places: [{ id: "region:3886", name: "Texas, United States" }],
        excluded_places: [{ id: "city:2418956", name: "Dallas, Texas" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("Reddit Create new ad", () => {
  it("asks for no total limit: Zavi picks it and the plan shows it", () => {
    const fields = (reddit_ads.topActions![0].fields ?? []).map((f) => f.name);
    expect(fields).toEqual(["about", "link", "daily_budget", "countries", "excluded_countries"]);
    expect(reddit_ads.topActions![0].note).toContain("$100");
  });
});

describe("TikTok video", () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText("What should the ad say?"), { target: { value: "Teslas" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://upcar.ai/h" } });
  };

  it("sends a video Zavi made", async () => {
    api.context.mockResolvedValue({ currency: "USD", videos: [{ id: "zavi:11111111-2222-4333-8444-555555555555", label: "ugc-1.mp4" }] });
    api.start.mockResolvedValue({ run_id: null });
    render(<TopActionsRow slug="tiktok_ads" channelName="TikTok Ads" actions={tiktok_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
    await act(async () => {});
    fill();
    expect((screen.getByRole("button", { name: "Make a plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Video"), { target: { value: "zavi:11111111-2222-4333-8444-555555555555" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(api.start.mock.calls[0][3]).toMatchObject({ video: "zavi:11111111-2222-4333-8444-555555555555", daily_budget: 30, age_groups: [], gender: "GENDER_UNLIMITED", languages: [] });
  });

  it("sends the picked adult ages, gender and account language codes; removing a chip restores broad language targeting", async () => {
    api.context.mockResolvedValue({ currency: "USD", videos: [{ id: "zavi:11111111-2222-4333-8444-555555555555", label: "ugc-1.mp4" }], languages: [{ id: "en", label: "English" }, { id: "zh-Hant", label: "Traditional Chinese" }] });
    api.start.mockResolvedValue({ run_id: null });
    render(<TopActionsRow slug="tiktok_ads" channelName="TikTok Ads" actions={tiktok_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
    await act(async () => {});
    fill();
    fireEvent.change(screen.getByLabelText("Video"), { target: { value: "zavi:11111111-2222-4333-8444-555555555555" } });
    fireEvent.change(screen.getByLabelText("Ages"), { target: { value: "AGE_25_34" } });
    fireEvent.change(screen.getByLabelText("Ages"), { target: { value: "AGE_35_44" } });
    fireEvent.click(screen.getByRole("radio", { name: "Female" }));
    fireEvent.change(screen.getByLabelText("Languages"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove English" }));
    expect(screen.getByText("All languages")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Languages"), { target: { value: "zh-Hant" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Make a plan" })); });
    expect(api.start.mock.calls[0][3]).toMatchObject({ age_groups: ["AGE_25_34", "AGE_35_44"], gender: "GENDER_FEMALE", languages: ["zh-Hant"] });
  });

  it("language discovery failure is visible but does not block an all-languages launch", async () => {
    api.context.mockResolvedValue({ currency: "USD", videos: [{ id: "zavi:11111111-2222-4333-8444-555555555555", label: "ugc-1.mp4" }], languages: [], languages_error: true });
    api.start.mockResolvedValue({ run_id: null });
    render(<TopActionsRow slug="tiktok_ads" channelName="TikTok Ads" actions={tiktok_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
    await act(async () => {});
    fill();
    fireEvent.change(screen.getByLabelText("Video"), { target: { value: "zavi:11111111-2222-4333-8444-555555555555" } });
    expect(screen.getByText(/Language choices couldn't be loaded/)).toBeTruthy();
    expect((screen.getByLabelText("Languages") as HTMLSelectElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Make a plan" })); });
    expect(api.start.mock.calls[0][3]).toMatchObject({ languages: [] });
  });

  it("also explains a failed form-context request instead of showing a silently empty language list", async () => {
    api.context.mockRejectedValue(new Error("network unavailable"));
    render(<TopActionsRow slug="tiktok_ads" channelName="TikTok Ads" actions={tiktok_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
    await act(async () => {});
    expect(screen.getByText(/Language choices couldn't be loaded/)).toBeTruthy();
  });

  it("uploads an MP4 through the chat video upload and sends its path", async () => {
    api.context.mockResolvedValue({ currency: "USD", videos: [] });
    api.start.mockResolvedValue({ run_id: null });
    api.fetch.mockImplementation(async (url: string) => (url === "/api/chat/upload-video" ? ok({ video_path: "t/v.mp4" }) : ok({})));
    render(<TopActionsRow slug="tiktok_ads" channelName="TikTok Ads" actions={tiktok_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
    await act(async () => {});
    fill();
    const file = new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Upload a video"), { target: { files: [file] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 4100));
    });
    expect(api.fetch).toHaveBeenCalledWith("/api/chat/upload-video", expect.objectContaining({ method: "POST" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(api.start.mock.calls[0][3]).toMatchObject({ video: "upload:t/v.mp4" });
  }, 10_000);

  it("refuses a non-MP4, an oversize file and a non-vertical video before uploading", () => {
    expect(videoFileProblem({ type: "video/quicktime", size: 10 }, null)).toMatch(/MP4/);
    expect(videoFileProblem({ type: "video/mp4", size: 51 * 1024 * 1024 }, null)).toMatch(/50 MB/);
    expect(videoFileProblem({ type: "video/mp4", size: 10 }, { w: 1920, h: 1080 })).toMatch(/9:16/);
    expect(videoFileProblem({ type: "video/mp4", size: 10 }, { w: 1080, h: 1920 })).toBeNull();
  });
});

describe("link checks before sending", () => {
  it("X takes only status links or post ids", async () => {
    render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote a post" }));
    await act(async () => {});
    const posts = screen.getByLabelText("Posts");
    fireEvent.change(posts, { target: { value: "https://example.com/post/1" } });
    fireEvent.blur(posts);
    expect(screen.getByText(/Paste 1 to 10 links to your own X posts/)).toBeTruthy();
    fireEvent.change(posts, { target: { value: "https://x.com/acme/status/123\n456" } });
    expect(screen.queryByText(/Paste 1 to 10 links/)).toBeNull();
    expect((screen.getByRole("button", { name: "Make a plan" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("FormActionModal run hint on a channel whose spec hides the run cost", () => {
  const writeCopy = () => reddit_ads.topActions!.find((a) => a.key === "write_ad_copy")!;

  it("email_marketing: a run form whose context answers 120 credits prints no credit text", async () => {
    api.context.mockResolvedValue({ credits: 120 });
    await act(async () => {
      render(<FormActionModal slug="email_marketing" channelName="Email campaigns" action={writeCopy()} onClose={() => {}} onChanged={() => {}} />);
    });
    expect(api.context).toHaveBeenCalledWith("email_marketing", "write_ad_copy");
    const dialog = screen.getByRole("dialog", { name: "Write ad copy" });
    expect(dialog.textContent).not.toMatch(/credit|120/i);
  });

  it("reddit_ads, same 120 answer: the hint still says About 120 credits", async () => {
    api.context.mockResolvedValue({ credits: 120 });
    await act(async () => {
      render(<FormActionModal slug="reddit_ads" channelName="Reddit Ads" action={writeCopy()} onClose={() => {}} onChanged={() => {}} />);
    });
    expect(screen.getByRole("dialog", { name: "Write ad copy" }).textContent).toContain("About 120 credits");
  });
});

describe("X Ads target and exclude locations", () => {
  it("searches X's own places, down to cities, keeps one place out of both lists, and sends both", async () => {
    vi.useFakeTimers();
    try {
      const la = { id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA", kind: "City" };
      const us = { id: "96683cc9126741d1", name: "United States", kind: "Country" };
      api.fetch.mockImplementation(async (url: string) =>
        String(url).includes("/ad-locations/search?q=Los")
          ? ok({ places: [la] })
          : String(url).includes("/ad-locations/search?q=United")
            ? ok({ places: [us] })
            : ok({}),
      );
      render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Promote a post" }));
      await act(async () => {});
      expect(screen.queryByTestId("top-action-places")).toBeNull();

      fireEvent.change(screen.getByLabelText("Target locations"), { target: { value: "United" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.fetch).toHaveBeenCalledWith("/api/channels/x_ads/ad-locations/search?q=United");
      fireEvent.click(screen.getByRole("option", { name: /United States/ }));

      fireEvent.change(screen.getByLabelText("Exclude locations"), { target: { value: "United" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      const taken = screen.getByRole("option", { name: /United States/ }) as HTMLButtonElement;
      expect(taken.disabled).toBe(true);
      expect(taken.textContent).toContain("Targeted");

      fireEvent.change(screen.getByLabelText("Exclude locations"), { target: { value: "Los" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByRole("option", { name: /Los Angeles, CA, USA/ }).textContent).toContain("City");
      fireEvent.click(screen.getByRole("option", { name: /Los Angeles, CA, USA/ }));

      fireEvent.change(screen.getByLabelText("Posts"), { target: { value: "https://x.com/acme/status/123" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
      });
      expect(api.start.mock.calls[0][3]).toMatchObject({
        places: [{ id: us.id, name: us.name }],
        excluded_places: [{ id: la.id, name: la.name }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no places picked, sends none so Zavi uses the business's country, and sends the goal, duration and audience defaults", async () => {
    render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote a post" }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Posts"), { target: { value: "https://x.com/acme/status/123" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    const sent = api.start.mock.calls[0][3];
    expect(sent.places).toBeUndefined();
    expect(sent.excluded_places).toBeUndefined();
    expect(sent.total_budget).toBeUndefined();
    expect(sent.keywords).toBeUndefined();
    expect(sent).toMatchObject({ goal: "engage", duration: "open", gender: "any", age: "any", daily_budget: 15 });
  });

  it("starts at the business's country from the account's facts, and sends the goal, cap, duration and audience picked", async () => {
    const us = { id: "96683cc9126741d1", name: "United States" };
    api.context.mockResolvedValue({ places: [us] });
    render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Promote a post" }));
    await act(async () => {});
    expect(screen.getByText("United States")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Posts"), { target: { value: "https://x.com/acme/status/123" } });
    fireEvent.click(screen.getByRole("radio", { name: /Send people to a site/ }));
    fireEvent.click(screen.getByRole("radio", { name: /2 weeks/ }));
    fireEvent.change(screen.getByLabelText("Total spend cap"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Keywords (optional)"), { target: { value: "saas, startup" } });
    fireEvent.change(screen.getByLabelText("Languages (optional)"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("radio", { name: /Women/ }));
    fireEvent.click(screen.getByRole("radio", { name: /25 to 49/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(api.start.mock.calls[0][3]).toEqual({
      posts: "https://x.com/acme/status/123",
      goal: "visit",
      daily_budget: 15,
      total_budget: 200,
      duration: "14",
      places: [us],
      keywords: "saas, startup",
      languages: "en",
      gender: "women",
      age: "25_49",
    });
  });

  it("Create new ad asks what it is about and an optional link, and sends one new-ad request", async () => {
    render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create new ad" }));
    await act(async () => {});
    expect(screen.queryByLabelText("Posts")).toBeNull();
    fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "Book a car in two taps" } });
    fireEvent.change(screen.getByLabelText("Link (optional)"), { target: { value: "https://example.com/start" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(api.start).toHaveBeenCalledWith("x_ads", "create_new_ad", expect.anything(), expect.objectContaining({ about: "Book a car in two taps", link: "https://example.com/start", goal: "engage" }));
  });
});
