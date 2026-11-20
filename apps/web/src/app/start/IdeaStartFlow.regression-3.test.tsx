// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as consent from "@/lib/consent";
vi.mock("next/image", () => ({
    default: ({ unoptimized, priority, ...props }: ComponentProps<"img"> & {
        unoptimized?: boolean;
        priority?: boolean;
    }) => <img {...props}/>,
}));
const push = vi.fn();
const replace = vi.fn();
const router = { push, replace };
let search = new URLSearchParams();
vi.mock("next/font/local", () => ({ default: () => ({ className: "", variable: "", style: {} }) }));
vi.mock("next/navigation", () => ({
    useRouter: () => router,
    useSearchParams: () => search,
}));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
vi.mock("next/link", () => ({
    default: ({ children, href }: {
        children: React.ReactNode;
        href: string;
    }) => (<a href={href}>{children}</a>),
}));
const supabase = {
    auth: {
        getSession: vi.fn(async () => ({
            data: { session: { access_token: "tok", user: { id: "user-1", last_sign_in_at: new Date().toISOString() } } },
        })),
        refreshSession: vi.fn(async () => ({ data: { session: null } })),
    },
    from: () => ({
        select: () => ({
            eq: () => ({
                maybeSingle: async () => ({ data: { active_tenant_id: null } }),
            }),
        }),
    }),
};
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => supabase }));
const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
    apiUrl: (path: string) => `http://api.test${path}`,
    apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const creatorHome = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/creator/api", () => {
    class CreatorApiError extends Error {
        constructor(readonly code: string, message: string, readonly status: number) {
            super(message);
        }
    }
    return { CreatorApiError, creatorApi: { home: creatorHome.fn } };
});
vi.mock("@/lib/browser-tenant", () => ({ writeStoredTenant: vi.fn(async () => { }) }));
vi.mock("@/lib/ensure-tenant-claim", () => ({ decodeActiveTenantClaim: () => null }));
const switchToTenantDetailed = vi.hoisted(() => vi.fn(async (_id: string) => "ok"));
vi.mock("@/lib/workspace/tenantSwitch", async (original) => ({
    ...(await original<typeof import("@/lib/workspace/tenantSwitch")>()),
    switchToTenantDetailed: (id: string) => switchToTenantDetailed(id),
}));
const fetchActiveTenant = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tenant", () => ({
    fetchActiveTenant: (...args: unknown[]) => fetchActiveTenant(...args),
}));
vi.mock("./BrainstormPanel", () => ({ BrainstormPanel: () => null }));
const tracked = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/events", () => ({ trackEvent: tracked, trackEventDeferred: tracked }));
import StartPage, { mayAutoResume } from "./page";
import { resetSiteTemplatesCache } from "@/lib/workspace/siteTemplates";
import { IDEA_IMAGE_COUNT_ERROR, IDEA_IMAGE_SIZE_ERROR, IDEA_IMAGE_TOTAL_ERROR, IDEA_IMAGE_TOTAL_MAX_CHARS, IDEA_IMAGE_TYPE_ERROR, } from "./IdeaImageAttach";
import { IDEA_EXAMPLES, IDEA_TOO_SHORT_HINT, WEBSITE_COMMIT_BODY, resetWebsiteFramingForTests, } from "@/lib/workspace/buildFraming";
function json(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const TEMPLATE_IDEA = "A website for my [type of business] in [town]. People in [town] book a time online.";
const SITE_TEMPLATES = {
    templates: [
        {
            id: "book-a-service",
            label: "Book a service",
            blurb: "Show what you offer and let people book a time.",
            good_for: "Salons, trades, clinics",
            idea: TEMPLATE_IDEA,
            layout: "split",
            fonts: { display: "DM Sans", body: "Inter" },
            theme_css: ":root { --background: 255 255 255; }",
            preview: { name: "Your business", headline: "Book your next visit", hero_variant: "split", sections: [{ title: "Services", body: "What we offer", kind: "Features", variant: "cards" }] },
        },
    ],
};
let framingOn = false;
let ideaExamplesOn = false;
let ideaAttachOn = false;
let framingFails = false;
let framingGate: Promise<void> | null = null;
const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/api/public/build-framing") && framingGate)
        await framingGate;
    if (url.endsWith("/api/public/build-framing") && framingFails)
        throw new TypeError("Failed to fetch");
    if (url.endsWith("/api/public/build-framing"))
        return json({ website_framing: framingOn, idea_examples: ideaExamplesOn, idea_attach: ideaAttachOn });
    if (url.endsWith("/api/public/site-templates"))
        return json(SITE_TEMPLATES);
    if (url.endsWith("/api/onboarding/generate-memory")) {
        return json({ memory: { company: "", ops: "", policies: "", disputes: "", support: "" } });
    }
    throw new Error(`unexpected fetch ${url}`);
});
beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    apiFetch.mockReset();
    creatorHome.fn.mockReset();
    creatorHome.fn.mockResolvedValue({ home: "/start", has_company: false, in_any_company: false, is_creator: false });
    fetchActiveTenant.mockReset();
    fetchActiveTenant.mockResolvedValue({ id: "tenant-existing", displayName: "Acme" });
    fetchMock.mockClear();
    search = new URLSearchParams();
    framingOn = false;
    ideaExamplesOn = false;
    ideaAttachOn = false;
    framingFails = false;
    framingGate = null;
    resetWebsiteFramingForTests();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.clear();
    sessionStorage.clear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    supabase.auth.getSession = vi.fn(async () => ({
        data: { session: { access_token: "tok", user: { id: "user-1", last_sign_in_at: new Date().toISOString() } } },
    })) as never;
});
describe("the idea page helps a visitor start", () => {
const signedOut = () => {
    supabase.auth.getSession = vi.fn(async () => ({ data: { session: null } })) as never;
    search = new URLSearchParams("step=idea");
};
const settle = async () => {
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/public/build-framing", expect.objectContaining({ signal: expect.any(AbortSignal) })));
    await act(async () => {
        for (let i = 0; i < 5; i += 1)
            await Promise.resolve();
    });
};
const submit = () => screen.getByRole("button", { name: "Sign up to build" }) as HTMLButtonElement;
it("an example fills the box with a full idea that can be sent, and the stash carries that idea to signup", async () => {
    ideaExamplesOn = true;
    signedOut();
    render(<StartPage />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    const chip = await screen.findByRole("button", { name: IDEA_EXAMPLES[1].label });
    expect(submit().disabled).toBe(true);
    fireEvent.click(chip);
    expect(box.value).toBe(IDEA_EXAMPLES[1].idea);
    expect(document.activeElement).toBe(box);
    expect(submit().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: IDEA_EXAMPLES[0].label })).toBeNull();
    fireEvent.click(submit());
    expect(push).toHaveBeenCalledWith("/login?signup=1&intent=build&next=%2Fstart%3Fresume%3Dbuild");
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({
        intent: "fresh",
        idea: IDEA_EXAMPLES[1].idea,
    });
});
it("a tagged link's utm tags ride the login next, so the signup keeps them without a cookie", async () => {
    ideaExamplesOn = true;
    signedOut();
    search = new URLSearchParams("step=idea&utm_source=x&utm_campaign=launch2&gclid=1");
    render(<StartPage />);
    fireEvent.click(await screen.findByRole("button", { name: IDEA_EXAMPLES[1].label }));
    fireEvent.click(submit());
    expect(push).toHaveBeenCalledWith(
        `/login?signup=1&intent=build&next=${encodeURIComponent("/start?resume=build&utm_source=x&utm_campaign=launch2")}`,
    );
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({
        intent: "fresh",
        idea: IDEA_EXAMPLES[1].idea,
    });
    expect(apiFetch).not.toHaveBeenCalled();
});
it("Start from a template opens a dialog that asks each blank, fills the idea box, and carries the template to signup; Escape leaves the idea alone", async () => {
    resetSiteTemplatesCache();
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
    };
    signedOut();
    render(<StartPage />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    const mine = "A calm yoga studio website with classes and contact details.";
    fireEvent.change(box, { target: { value: mine } });
    const trigger = screen.getByRole("button", { name: "Start from a template" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("template-book-a-service"));
    const dialog = screen.getByRole("dialog", { name: "Book a service" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "dog grooming salon" } });
    fireEvent.keyDown(within(dialog).getByRole("textbox"), { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box.value).toBe(mine);
    expect(screen.queryByTestId("template-chip")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("template-book-a-service"));
    const again = screen.getByRole("dialog", { name: "Book a service" });
    expect(within(again).getByText("1 of 2")).toBeTruthy();
    fireEvent.change(within(again).getByRole("textbox"), { target: { value: "dog grooming salon" } });
    fireEvent.keyDown(within(again).getByRole("textbox"), { key: "Enter" });
    expect(within(again).getByText("Which town is it in?")).toBeTruthy();
    fireEvent.change(within(again).getByRole("textbox"), { target: { value: "Bath" } });
    fireEvent.click(within(again).getByRole("button", { name: "Next" }));
    fireEvent.click(within(again).getByRole("button", { name: "Use this template" }));
    const filled = "A website for my dog grooming salon in Bath. People in Bath book a time online.";
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box.value).toBe(filled);
    expect(screen.getByTestId("template-chip").textContent).toContain("Template: Book a service");
    expect(tracked).toHaveBeenCalledWith("onboarding_template_picked", { template: "book-a-service" });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    expect(push).toHaveBeenCalledWith("/login?signup=1&intent=build&next=%2Fstart%3Fresume%3Dbuild");
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({
        intent: "fresh",
        idea: filled,
        template: { id: "book-a-service", label: "Book a service", idea: TEMPLATE_IDEA },
    });
});
it("every example is long enough to send", () => {
    expect(IDEA_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const ex of IDEA_EXAMPLES)
        expect(ex.idea.trim().length).toBeGreaterThanOrEqual(8);
});
it("says why the button is off for 'hi' and 'cake', and drops the reason once the idea is long enough", async () => {
    ideaExamplesOn = true;
    signedOut();
    render(<StartPage />);
    const box = await screen.findByRole("textbox");
    await settle();
    expect(screen.queryByText(IDEA_TOO_SHORT_HINT)).toBeNull();
    for (const short of ["hi", "cake", "  cake   "]) {
        fireEvent.change(box, { target: { value: short } });
        expect(submit().disabled).toBe(true);
        expect(screen.getByText(IDEA_TOO_SHORT_HINT)).toBeTruthy();
        fireEvent.keyDown(box, { key: "Enter", metaKey: true });
        expect(push).not.toHaveBeenCalled();
    }
    fireEvent.change(box, { target: { value: "   " } });
    expect(screen.queryByText(IDEA_TOO_SHORT_HINT)).toBeNull();
    fireEvent.change(box, { target: { value: "cake site" } });
    expect(submit().disabled).toBe(false);
    expect(screen.queryByText(IDEA_TOO_SHORT_HINT)).toBeNull();
});
it("shows neither examples nor the hint when the setting is off", async () => {
    signedOut();
    render(<StartPage />);
    const box = await screen.findByRole("textbox");
    await settle();
    for (const ex of IDEA_EXAMPLES)
        expect(screen.queryByRole("button", { name: ex.label })).toBeNull();
    fireEvent.change(box, { target: { value: "hi" } });
    expect(submit().disabled).toBe(true);
    expect(screen.queryByText(IDEA_TOO_SHORT_HINT)).toBeNull();
});
it("asks again on the next visit after one failed settings read, and then follows the real answer", async () => {
    ideaExamplesOn = false;
    framingFails = true;
    signedOut();
    render(<StartPage />);
    await screen.findByRole("textbox");
    expect(await screen.findByRole("button", { name: IDEA_EXAMPLES[0].label })).toBeTruthy();
    cleanup();
    framingFails = false;
    fetchMock.mockClear();
    signedOut();
    render(<StartPage />);
    await screen.findByRole("textbox");
    await settle();
    for (const ex of IDEA_EXAMPLES)
        expect(screen.queryByRole("button", { name: ex.label })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/public/build-framing", expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
it("shows the examples and the too-short hint when the settings read fails, because both default on", async () => {
    ideaExamplesOn = false;
    framingFails = true;
    signedOut();
    render(<StartPage />);
    const box = await screen.findByRole("textbox");
    await settle();
    for (const ex of IDEA_EXAMPLES)
        expect(screen.getByRole("button", { name: ex.label })).toBeTruthy();
    fireEvent.change(box, { target: { value: "hi" } });
    expect(screen.getByText(IDEA_TOO_SHORT_HINT)).toBeTruthy();
});
});
describe("idea step: attach an image", () => {
const idea = "Build a calm yoga studio website with classes and contact details.";
const pngFile = (name = "sketch.png", bytes = 64) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(bytes).fill(1)])], name, {
    type: "image/png",
});
const signedOut = () => {
    supabase.auth.getSession = vi.fn(async () => ({ data: { session: null } })) as never;
};
const attach = async (files: File[]) => {
    const input = (await screen.findByLabelText("Attach image")) as HTMLInputElement;
    await act(async () => {
        fireEvent.change(input, { target: { files } });
    });
};
const refused402 = () => json({
    error: {
        code: "insufficient_credits_for_build",
        message: "Add credits to start this build.",
        required_credits: 10,
        remaining_credits: 0,
    },
    tenant_id: "tenant-new",
}, 402);
const bodyOf = (i: number) => JSON.parse((apiFetch.mock.calls[i]?.[1] as {
    body: string;
}).body);
const stashWithImages = (images: string[]) => {
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    window.sessionStorage.setItem("praxis_pending_build:images", JSON.stringify(images));
};
const IMGS = ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"];
it("attaches up to three previews with remove buttons and rejects wrong type, oversize and a fourth", async () => {
    ideaAttachOn = true;
    signedOut();
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await attach([new File(["GIF89a"], "anim.gif", { type: "image/gif" })]);
    expect((await screen.findByRole("alert")).textContent).toBe(IDEA_IMAGE_TYPE_ERROR);
    expect(screen.queryByRole("img", { name: /^Attached image/ })).toBeNull();
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
    await attach([big]);
    expect((await screen.findByRole("alert")).textContent).toBe(IDEA_IMAGE_SIZE_ERROR);
    expect(screen.queryByRole("img", { name: /^Attached image/ })).toBeNull();
    await attach([pngFile("a.png"), pngFile("b.png"), pngFile("c.png"), pngFile("d.png")]);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(3));
    expect(screen.getByRole("alert").textContent).toBe(IDEA_IMAGE_COUNT_ERROR);
    expect((screen.getByLabelText("Attach image") as HTMLInputElement).disabled).toBe(true);
    const srcs = screen.getAllByRole("img", { name: /^Attached image/ }).map((i) => i.getAttribute("src"));
    expect(srcs.every((s) => s?.startsWith("data:image/png;base64,"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove image 2" }));
    expect(screen.getAllByRole("img", { name: /^Attached image/ }).map((i) => i.getAttribute("src"))).toEqual([srcs[0], srcs[2]]);
    expect(screen.getByRole("img", { name: "Attached image 2" })).toBeTruthy();
    expect((screen.getByLabelText("Attach image") as HTMLInputElement).disabled).toBe(false);
});
it("carries the images across the signup hop and sends them on the build-start that follows", async () => {
    ideaAttachOn = true;
    signedOut();
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: idea } });
    await attach([pngFile("a.png"), pngFile("b.png", 9)]);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(2));
    const srcs = screen.getAllByRole("img", { name: /^Attached image/ }).map((i) => i.getAttribute("src"));
    fireEvent.click(screen.getByRole("button", { name: "Sign up to build" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls[0]?.[0])).toContain("/login?signup=1");
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({
        intent: "fresh",
        idea,
    });
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).not.toHaveProperty("images");
    expect(JSON.parse(window.sessionStorage.getItem("praxis_pending_build:images") ?? "[]")).toEqual(srcs);
    cleanup();
    supabase.auth.getSession = vi.fn(async () => ({
        data: { session: { access_token: "tok", user: { id: "user-1", last_sign_in_at: new Date().toISOString() } } },
    })) as never;
    apiFetch.mockResolvedValue(json({}, 500));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
    const sent = JSON.parse((apiFetch.mock.calls[0]?.[1] as {
        body: string;
    }).body);
    expect(sent.idea).toBe(idea);
    expect(sent.reference_images).toEqual(srcs);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(2));
});
it("sends the URL campaign to build-start after signup even when analytics is declined", async () => {
    const choice = vi.spyOn(consent, "hasAnalyticsConsent").mockReturnValue(false);
    try {
        window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
        search = new URLSearchParams("resume=build&utm_source=email&utm_medium=email&utm_campaign=launch2");
        apiFetch.mockResolvedValue(json({}, 500));
        render(<StartPage />);
        await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
        expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
        expect(JSON.parse(apiFetch.mock.calls[0][1].body).attribution).toEqual({ utm_source: "email", utm_medium: "email", utm_campaign: "launch2" });
    } finally { choice.mockRestore(); }
});
it("drops a tampered stash entry instead of sending it", async () => {
    ideaAttachOn = true;
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    window.sessionStorage.setItem("praxis_pending_build:images", JSON.stringify(["https://evil.example/x.png", "data:image/png;base64,AAAA"]));
    apiFetch.mockResolvedValue(json({}, 500));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const sent = JSON.parse((apiFetch.mock.calls[0]?.[1] as {
        body: string;
    }).body);
    expect(sent.reference_images).toEqual(["data:image/png;base64,AAAA"]);
});
it("images left in the origin-wide stash by another tab or person are never sent (review F4)", async () => {
    ideaAttachOn = true;
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, images: ["data:image/png;base64,AAAA"], at: Date.now() }));
    apiFetch.mockResolvedValue(json({}, 500));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const sent = JSON.parse((apiFetch.mock.calls[0]?.[1] as {
        body: string;
    }).body);
    expect(sent).not.toHaveProperty("reference_images");
});
it("flag off: no attach control and nothing extra in the stash or the request", async () => {
    signedOut();
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: idea } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByLabelText("Attach image")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign up to build" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).not.toHaveProperty("images");
});
it("an existing account's auto-resume sends the stashed images to build-product, and so does the retry click", async () => {
    ideaAttachOn = true;
    creatorHome.fn.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: false });
    stashWithImages(IMGS);
    apiFetch.mockResolvedValue(refused402());
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(bodyOf(0).reference_images).toEqual(IMGS);
    await screen.findByText("Not enough credits for this build.");
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(2));
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "b" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(bodyOf(0).reference_images).toEqual(IMGS);
});
it("an existing account outside the auto-resume window sends the images when they click Build it", async () => {
    ideaAttachOn = true;
    creatorHome.fn.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: false });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() - 31 * 60 * 1000 }));
    window.sessionStorage.setItem("praxis_pending_build:images", JSON.stringify(IMGS));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "b" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(2));
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(bodyOf(0).reference_images).toEqual(IMGS);
});
it("a new account refused on credits by build-start retries through build-product with the same images", async () => {
    ideaAttachOn = true;
    stashWithImages(IMGS);
    apiFetch.mockResolvedValue(refused402());
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
    expect(bodyOf(0).reference_images).toEqual(IMGS);
    await screen.findByText("Not enough credits for this build.");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-new", build_id: "b" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(bodyOf(0).reference_images).toEqual(IMGS);
});
});
