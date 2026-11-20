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
it("refuses an image that would push the set past what the stash and the request can carry", async () => {
    ideaAttachOn = true;
    supabase.auth.getSession = vi.fn(async () => ({ data: { session: null } })) as never;
    search = new URLSearchParams("step=idea&resume=build");
    render(<StartPage />);
    const chunk = Math.floor((IDEA_IMAGE_TOTAL_MAX_CHARS * 3) / 4 / 2) + 1024;
    await attach([pngFile("a.png", chunk)]);
    await waitFor(() => expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(1));
    await attach([pngFile("b.png", chunk)]);
    expect((await screen.findByRole("alert")).textContent).toBe(IDEA_IMAGE_TOTAL_ERROR);
    expect(screen.getAllByRole("img", { name: /^Attached image/ })).toHaveLength(1);
});
});
