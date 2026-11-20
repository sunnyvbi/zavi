// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
describe("/start routes from the backend's home decision (S3)", () => {
const creatorOnly = { home: "/creator", has_company: false, in_any_company: false, is_creator: true };
it("keeps the public website form visible for a signed-in creator", async () => {
    creatorHome.fn.mockResolvedValue(creatorOnly);
    render(<StartPage />);
    await screen.findByText("Website URL");
    expect(replace).not.toHaveBeenCalled();
});
it("does not redirect with ?new=1 (a creator starting a company)", async () => {
    creatorHome.fn.mockResolvedValue(creatorOnly);
    search = new URLSearchParams("new=1");
    render(<StartPage />);
    await new Promise((r) => setTimeout(r, 50));
    expect(replace).not.toHaveBeenCalledWith("/creator");
});
it("a founder (not a creator) stays on the funnel", async () => {
    render(<StartPage />);
    await screen.findByText("Website URL");
    expect(replace).not.toHaveBeenCalledWith("/creator");
});
it("keeps the public website form visible for an existing company account", async () => {
    creatorHome.fn.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: true });
    render(<StartPage />);
    await screen.findByText("Website URL");
    expect(replace).not.toHaveBeenCalled();
});
it("resumes a landing-page website idea before redirecting an existing company account", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValue(json({
        error: {
            code: "insufficient_credits_for_build",
            message: "Add credits to start this build.",
            required_credits: 10,
            remaining_credits: 0,
        },
    }, 402));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({
        idea,
        company_name: "Acme",
        await_look_pick: true,
    });
    expect(replace).not.toHaveBeenCalledWith("/workspace");
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    expect(apiFetch.mock.calls[0]?.[1]).toMatchObject({ idempotent: true });
    await screen.findByRole("alert");
    expect(screen.getByText("Not enough credits for this build.")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ intent: "fresh", idea });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({
        idea,
        company_name: "Acme",
        await_look_pick: true,
    });
    await waitFor(() => expect(window.localStorage.getItem("praxis_pending_build")).toBeNull());
    cleanup();
    apiFetch.mockClear();
    replace.mockClear();
    render(<StartPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace"));
    expect(apiFetch).not.toHaveBeenCalled();
});
it("a template picked before sign-up survives the round trip: the build starts from it", async () => {
    const idea = "A website for my bike repair shop in Leeds. Customers book a time online.";
    const template = { id: "book-a-service", label: "Book a service", idea: "A website for my [type of business] in [town]. Customers book a time online." };
    creatorHome.fn.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: false });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, template, at: Date.now() }));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({ idea, company_name: "Acme", template: "book-a-service", await_look_pick: true });
});
it("a network failure on the auto-resume keeps the stash; a refresh shows the idea and waits for a click instead of firing a second request", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockRejectedValueOnce(new Error("Failed to fetch"));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await screen.findByText("Failed to fetch");
    expect(replace).not.toHaveBeenCalledWith("/workspace");
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ intent: "fresh", idea });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    cleanup();
    apiFetch.mockClear();
    replace.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    await waitFor(() => expect(screen.getByRole("button", { name: "Build it" })).toBeTruthy());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalledWith("/workspace");
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({
        idea,
        company_name: "Acme",
        await_look_pick: true,
    });
    await waitFor(() => expect(window.localStorage.getItem("praxis_pending_build")).toBeNull());
    expect(window.sessionStorage.getItem("praxis_pending_build")).toBeNull();
    cleanup();
    apiFetch.mockClear();
    replace.mockClear();
    render(<StartPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace"));
    expect(apiFetch).not.toHaveBeenCalled();
});
it("an existing account signing in with a stale stash is not charged: a stash older than 24h is ignored and cleared", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() - 25 * 60 * 60 * 1000 }));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace"));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchActiveTenant).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("praxis_pending_build")).toBeNull();
    expect(window.sessionStorage.getItem("praxis_pending_build")).toBeNull();
    expect(screen.queryByText(idea)).toBeNull();
});
it("a stash without a timestamp is ignored", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea }));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace"));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchActiveTenant).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("praxis_pending_build")).toBeNull();
    expect(window.sessionStorage.getItem("praxis_pending_build")).toBeNull();
});
it("re-resolves the workspace on Build it when the first lookup failed, instead of a build-start that would 409 and drop the idea", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    fetchActiveTenant.mockResolvedValueOnce(null);
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await screen.findByText(/We could not open your workspace/);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ intent: "fresh", idea });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(fetchActiveTenant).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("praxis_pending_build")).toBeNull();
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({
        idea,
        company_name: "Acme",
        await_look_pick: true,
    });
});
it("a credit refusal on Build it after a failed workspace lookup keeps the stash for the next attempt", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    fetchActiveTenant.mockResolvedValueOnce(null);
    apiFetch.mockResolvedValueOnce(json({ error: { code: "insufficient_credits_for_build", message: "Add credits.", required_credits: 10, remaining_credits: 0 } }, 402));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await screen.findByText(/We could not open your workspace/);
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");
    expect(screen.getByText("Not enough credits for this build.")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ intent: "fresh", idea });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    cleanup();
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({ idea, company_name: "Acme", await_look_pick: true });
    await waitFor(() => expect(window.localStorage.getItem("praxis_pending_build")).toBeNull());
});
it("retries an unknown post-creation failure against the committed tenant instead of creating another", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({
        error: { code: "build_start_failed", message: "Temporary failure." },
        tenant_id: "tenant-created",
        company_name: "Committed Bakery",
    }, 500));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
    await screen.findByText("Backend hit an error. Try again in a moment.");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-created", build_id: "build-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(switchToTenantDetailed).toHaveBeenCalledWith("tenant-created");
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({
        idea,
        company_name: "Committed Bakery",
        await_look_pick: true,
    });
});
it("does not retry a build when the session cannot be pinned to the created company", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({
        error: { code: "build_start_failed", message: "Temporary failure." },
        tenant_id: "tenant-created",
        company_name: "Committed Bakery",
    }, 500));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await screen.findByText("Backend hit an error. Try again in a moment.");
    apiFetch.mockClear();
    switchToTenantDetailed.mockResolvedValueOnce("not_converged");
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await screen.findByText(/could not open your new workspace/);
    expect(apiFetch).not.toHaveBeenCalled();
});
it("a build request whose response was lost is never replayed: the next visit shows the idea and waits for a click", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now(), dispatched: true }));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-2" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    await waitFor(() => expect(screen.getByRole("button", { name: "Build it" })).toBeTruthy());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchActiveTenant).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalledWith("/workspace");
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ intent: "fresh", idea, dispatched: true });
});
it("marks the stash dispatched before the first build request leaves the browser", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    let seenAtRequest: unknown = null;
    apiFetch.mockImplementationOnce(async () => {
        seenAtRequest = JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "null");
        return new Promise(() => { });
    });
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(seenAtRequest).toMatchObject({ intent: "fresh", idea, dispatched: true });
});
it("locks the idea form while an existing account's workspace is being resolved, so a click cannot race the auto-resume", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    fetchActiveTenant.mockReturnValue(new Promise(() => { }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await screen.findByTestId("build-start-layout");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ intent: "fresh", idea });
});
});
