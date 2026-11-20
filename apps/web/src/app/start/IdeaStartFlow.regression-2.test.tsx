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
it("restores a signed-out landing-page idea after refresh or Back", async () => {
    const idea = "Build a calm yoga studio website with classes and contact details.";
    supabase.auth.getSession = vi.fn(async () => ({ data: { session: null } })) as never;
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(box.value).toBe(idea);
    expect((screen.getByRole("button", { name: "Sign up to build" }) as HTMLButtonElement)
        .disabled).toBe(false);
});
it("a new account never replays a build-start that already left the browser: a refresh shows the idea and waits for a click", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
    await screen.findByText("Failed to fetch");
    expect(JSON.parse(window.localStorage.getItem("praxis_pending_build") ?? "{}")).toMatchObject({ idea, dispatched: true });
    cleanup();
    apiFetch.mockClear();
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    await waitFor(() => expect(screen.getByRole("button", { name: "Build it" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch).not.toHaveBeenCalled();
});
it("a 503 build_not_configured from build-start shows the server's honest message, not a generic backend error", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    const message = "Builds are temporarily unavailable. Nothing was started and nothing was charged. Please try again later.";
    apiFetch.mockResolvedValueOnce(json({ error: { code: "build_not_configured", message }, tenant_id: "tenant-new", company_name: "Acme" }, 503));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText("Backend hit an error. Try again in a moment.")).toBeNull();
    expect(replace).not.toHaveBeenCalledWith("/workspace");
});
it("after a 503 build_not_configured, the next Build it starts the build in the workspace build-start already created", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    const message = "Builds are temporarily unavailable. Nothing was started and nothing was charged. Please try again later.";
    apiFetch.mockResolvedValueOnce(json({ error: { code: "build_not_configured", message }, tenant_id: "tenant-new", company_name: "Bakery Co" }, 503));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect(await screen.findByText(message)).toBeTruthy();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe(idea);
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-new", build_id: "build-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(JSON.parse(apiFetch.mock.calls[0]?.[1].body as string)).toEqual({ idea, company_name: "Bakery Co", await_look_pick: true });
    expect(apiFetch.mock.calls.some((c) => c[0] === "/api/onboarding/build-start")).toBe(false);
});
it("retries any failed onboarding response with a created tenant through the workspace build route", async () => {
    const idea = "Build a bakery website.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({ error: { code: "unavailable", message: "Repo provisioning failed." }, tenant_id: "tenant-new", company_name: "Bakery Co" }, 500));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect(await screen.findByText("Backend hit an error. Try again in a moment.")).toBeTruthy();
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-new", build_id: "build-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
});
it("a 503 build_not_configured without a message still says builds are unavailable, not a backend error", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({ error: { code: "build_not_configured" } }, 503));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect(await screen.findByText(/Builds are temporarily unavailable/)).toBeTruthy();
    expect(screen.queryByText("Backend hit an error. Try again in a moment.")).toBeNull();
});
it("a 403 product_builder_disabled from build-start says building is paused, not 'Something went wrong'", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({ error: { code: "product_builder_disabled", message: "Product builder is not enabled." } }, 403));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect(await screen.findByText(/Building new apps is paused right now/)).toBeTruthy();
    expect(screen.queryByText("Something went wrong. Please try again.")).toBeNull();
});
it("build-start answering that the same idea is still being set up keeps the founder here, with a retry, and sends the intent's key", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({ error: { code: "idempotency_in_progress", message: "Your build is still being set up." } }, 409));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect(await screen.findByText(/still being set up/)).toBeTruthy();
    const call = apiFetch.mock.calls.find(([url]) => url === "/api/onboarding/build-start");
    expect((call?.[1] as {
        headers?: Record<string, string>;
    } | undefined)?.headers?.["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
});
it("retries an incomplete build start in the workspace without clearing the idea", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
    apiFetch.mockResolvedValueOnce(json({ error: { code: "build_start_incomplete" }, tenant_id: "tenant-new", company_name: "Bakery Co" }, 409));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect(await screen.findByText(/build did not start/i)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    expect(window.localStorage.getItem("praxis_pending_build")).not.toBeNull();
    apiFetch.mockClear();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-new", build_id: "build-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/workspace/autopilot/build-product");
    expect(switchToTenantDetailed).toHaveBeenCalledWith("tenant-new");
});
it("an idea stashed on a shared browser does not start a paid build for an account that was already signed in", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    creatorHome.fn.mockResolvedValue({
        home: "/workspace",
        has_company: true,
        in_any_company: true,
        is_creator: false,
    });
    supabase.auth.getSession = vi.fn(async () => ({
        data: {
            session: {
                access_token: "tok",
                user: { id: "user-2", last_sign_in_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
            },
        },
    })) as never;
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() - 5 * 60 * 1000 }));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Build it" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchActiveTenant).not.toHaveBeenCalled();
});
it("an idea stashed more than 30 minutes before sign-in waits for a click instead of building", async () => {
    const idea = "Build a warm one-page bakery website with a menu and contact form.";
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() - 45 * 60 * 1000 }));
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-1" }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch).not.toHaveBeenCalled();
});
it("does not require an account lookup to show the public website form", async () => {
    creatorHome.fn.mockRejectedValue(new Error("down"));
    render(<StartPage />);
    expect(await screen.findByText("Website URL")).toBeTruthy();
    expect(creatorHome.fn).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
});
});
describe("/start carries the plan picked on /pricing", () => {

it("stashes a paid ?plan=&term= for the workspace plan page", async () => {
    window.localStorage.clear();
    search = new URLSearchParams("plan=growth&term=6mo");
    render(<StartPage />);
    await screen.findByText("Website URL");
    const stash = JSON.parse(window.localStorage.getItem("zavi.pendingPlan") ?? "null");
    expect(stash).toMatchObject({ tier: "growth", term: "6mo" });
});
it("ignores free and malformed plans", async () => {
    window.localStorage.clear();
    search = new URLSearchParams("plan=free&term=monthly");
    render(<StartPage />);
    await screen.findByText("Website URL");
    expect(window.localStorage.getItem("zavi.pendingPlan")).toBeNull();
});
});
describe("/start intake", () => {

it("a bare /start skips the fork and shows the Website URL intake", async () => {
    render(<StartPage />);
    await screen.findByText("Website URL");
    expect(screen.getByText(/Do 10× more/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create a new company/ })).toBeNull();
    const cont = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
});
it("add-company mode uses the same focused website intake", async () => {
    search = new URLSearchParams("step=website&new=1");
    render(<StartPage />);
    await screen.findByText("Website URL");
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(push).not.toHaveBeenCalled();
});
it("keeps the idea entry available through its URL", async () => {
    search = new URLSearchParams("step=idea");
    render(<StartPage />);
    await screen.findByText("What's your idea?");
    expect(screen.queryByRole("textbox", { name: "Website URL" })).toBeNull();
});
});
describe("mayAutoResume", () => {
const now = Date.parse("2026-09-28T12:00:00Z");
const at = now - 5 * 60 * 1000;
it("resumes a stash written just before this sign-in", () => {
    expect(mayAutoResume({ at }, new Date(now - 60 * 1000).toISOString(), now)).toBe(true);
});
it("never resumes a stash whose request already left the browser", () => {
    expect(mayAutoResume({ at, dispatched: true }, new Date(now).toISOString(), now)).toBe(false);
});
it("never resumes for a session that signed in before the stash was written", () => {
    expect(mayAutoResume({ at }, new Date(at - 10 * 60 * 1000).toISOString(), now)).toBe(false);
});
it("never resumes without a sign-in time", () => {
    expect(mayAutoResume({ at }, undefined, now)).toBe(false);
    expect(mayAutoResume({ at }, "not a date", now)).toBe(false);
});
it("never resumes a stash older than the sign-in round trip", () => {
    const old = now - 31 * 60 * 1000;
    expect(mayAutoResume({ at: old }, new Date(now).toISOString(), now)).toBe(false);
});
});
describe("QA lane1.2: an abandoned idea never starts a paid build on a later plain signup", () => {
const idea = "Photography portfolio site with a gallery and an enquiry form.";
function abandonedIdea() {
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() - 60 * 1000 }));
}
it("a brand-new account from plain /login?signup=1 lands on /start: the idea is offered back in the box, nothing is built", async () => {
    abandonedIdea();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-new", build_id: "build-1" }));
    search = new URLSearchParams();
    render(<StartPage />);
    await screen.findByRole("textbox", { name: "Website URL" });
    expect(apiFetch).not.toHaveBeenCalled();
    search = new URLSearchParams("step=idea");
    cleanup();
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Build it" })).toBeTruthy();
});
it("an existing account signing in from a plain login never builds the stashed idea in its workspace", async () => {
    abandonedIdea();
    creatorHome.fn.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: false });
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-existing", build_id: "build-1" }));
    search = new URLSearchParams("step=idea");
    render(<StartPage />);
    expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe(idea);
    await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchActiveTenant).not.toHaveBeenCalled();
});
it("control: the same stash coming back through Sign up to build still starts the build", async () => {
    abandonedIdea();
    apiFetch.mockResolvedValue(json({ tenant_id: "tenant-new", build_id: "build-1" }));
    search = new URLSearchParams("resume=build");
    render(<StartPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
});
});
describe("the website path never talks about an agent team", () => {
const AGENT_TEAM = /agent team/i;
const idea = "Build a warm one-page bakery website with a menu and contact form.";
function stashIdea() {
    window.localStorage.setItem("praxis_pending_build", JSON.stringify({ intent: "fresh", idea, at: Date.now() }));
}
it("hands a signed-out idea to signup marked as a build, so the signup panel can talk about the site", async () => {
    supabase.auth.getSession = vi.fn(async () => ({ data: { session: null } })) as never;
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    const box = await screen.findByRole("textbox");
    fireEvent.change(box, { target: { value: idea } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up to build" }));
    expect(push).toHaveBeenCalledWith("/login?signup=1&intent=build&next=%2Fstart%3Fresume%3Dbuild");
});
it("shows the build screen with the founder's idea, not a splash, while the new workspace is made", async () => {
    framingOn = true;
    stashIdea();
    apiFetch.mockReturnValue(new Promise(() => { }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    const layout = await screen.findByTestId("build-start-layout");
    expect(layout.textContent).toContain(idea);
    expect(within(layout).getByRole("status").textContent).toContain(WEBSITE_COMMIT_BODY);
    expect(screen.getByRole("region", { name: "Preview" })).toBeTruthy();
    expect(screen.queryByText("Setting up your workspace…")).toBeNull();
    expect(screen.queryByText(/two minutes/)).toBeNull();
    expect(screen.queryByText(AGENT_TEAM)).toBeNull();
    expect(apiFetch.mock.calls[0]?.[0]).toBe("/api/onboarding/build-start");
});
it("shows the build layout, never the two-minute splash, when the setting is off", async () => {
    stashIdea();
    apiFetch.mockReturnValue(new Promise(() => { }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await screen.findByTestId("build-start-layout");
    expect(screen.queryByText("Setting up your workspace…")).toBeNull();
    expect(screen.queryByText(/two minutes/)).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/public/build-framing", expect.objectContaining({ signal: expect.any(AbortSignal) })));
    await act(async () => {
        for (let i = 0; i < 5; i += 1)
            await Promise.resolve();
    });
    expect(screen.queryByText(AGENT_TEAM)).toBeNull();
    expect(screen.getByText(WEBSITE_COMMIT_BODY)).toBeTruthy();
});
it("never flashes the agent-team line while the setting is still being read", async () => {
    framingOn = true;
    let release: () => void = () => { };
    framingGate = new Promise<void>((r) => {
        release = r;
    });
    stashIdea();
    apiFetch.mockReturnValue(new Promise(() => { }));
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    await screen.findByTestId("build-start-layout");
    expect(screen.queryByText(AGENT_TEAM)).toBeNull();
    await act(async () => {
        release();
        for (let i = 0; i < 5; i += 1)
            await Promise.resolve();
    });
    const body = await screen.findByText(WEBSITE_COMMIT_BODY);
    expect(body.className).not.toContain("invisible");
    expect(screen.queryByText(AGENT_TEAM)).toBeNull();
});
});
