// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ job: null as unknown, calls: [] as Array<[string, unknown[]]>, jobImpl: null as null | (() => Promise<unknown>), submitFails: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/image", () => ({ default: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return {
    ...actual,
    creatorApi: new Proxy(
      {},
      {
        get: (_t, key: string) => {
          if (key === "jobs") return async () => ({ jobs: [h.job] });
          if (key === "job") return () => (h.jobImpl ? h.jobImpl() : Promise.resolve({ job: h.job }));
          if (key === "uploadUrl") return async (...a: unknown[]) => (h.calls.push(["uploadUrl", a]), { signed_url: "https://storage.test/put", path: "o1/x.mp4" });
          if (key === "submit" && h.submitFails)
            return async (...a: unknown[]) => {
              h.calls.push(["submit", a]);
              throw new Error("submit failed");
            };
          return async (...a: unknown[]) => (h.calls.push([key, a]), { messages: [], offers: [], ok: true });
        },
      },
    ),
  };
});

import { CreatorJobsScreen, fileSize } from "./CreatorJobs";

const job = {
  id: "o1", source: "booking", status: "in_progress", closed_reason: null, created_at: "2026-10-22T05:14:42Z",
  due_at: "2099-10-25T05:16:26Z", accepted_at: "2026-10-22T05:16:26Z", closed_at: null, extension_state: null,
  extension_requested_due_at: null, package: { title: "1 UGC video", kind: "ugc_video" }, brief: null, currency: "usd",
  price_cents: 400, creator_fee_cents: 60, creator_payout_cents: 340, amount_cents: 340, part_paid: false,
  payout_status: "not_due", payout_ready_at: null, deadline: null, submissions: [], has_thread: false,
  business_name: "UpcarAI", revisions_used: 0, revisions_max: 2,
};

class FakeXHR {
  static last: FakeXHR | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn(() => {
    FakeXHR.last = this;
  });
}

beforeEach(() => {
  h.job = job;
  h.jobImpl = null;
  h.calls = [];
  h.submitFails = false;
  FakeXHR.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  URL.createObjectURL = vi.fn(() => "blob:preview-1");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const video = (name = "talking_head.mp4", size = 12 * 1024 * 1024) => {
  const f = new File(["x"], name, { type: "video/mp4" });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

async function pick(files: File[]) {
  const input = (await screen.findByTestId("deliver-input")) as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

describe("delivering a video", () => {
  it("shows a playable preview of the picked video, with its size, and lets it be removed", async () => {
    render(<CreatorJobsScreen orderId="o1" />);
    await pick([video()]);
    const card = screen.getByTestId("picked-file");
    const player = within(card).getByLabelText("Preview of talking_head.mp4") as HTMLVideoElement;
    expect(player.tagName).toBe("VIDEO");
    expect(player.getAttribute("src")).toBe("blob:preview-1");
    expect(player.hasAttribute("controls")).toBe(true);
    expect(card.textContent).toContain("12.0 MB");
    expect(screen.getByRole("button", { name: "Add another file" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Remove talking_head.mp4" }));
    expect(screen.queryByTestId("picked-file")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(screen.getByRole("button", { name: /^Upload your video/ })).toBeTruthy();
  });

  it("refuses a file over 500 MB or of the wrong type, and says why", async () => {
    render(<CreatorJobsScreen orderId="o1" />);
    await pick([video("huge.mp4", 600 * 1024 * 1024), new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    expect(screen.queryByTestId("picked-file")).toBeNull();
    expect(screen.getByText(/huge\.mp4, notes\.pdf: use an MP4, MOV or WebM video/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit for approval" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows real upload progress on the file, locks removing it, then submits once", async () => {
    render(<CreatorJobsScreen orderId="o1" />);
    await pick([video()]);
    fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await vi.waitFor(() => expect(FakeXHR.last).not.toBeNull());
    act(() => FakeXHR.last!.upload.onprogress!({ lengthComputable: true, loaded: 45, total: 100 }));
    const bar = screen.getByRole("progressbar", { name: "Uploading talking_head.mp4" });
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByTestId("picked-file").textContent).toContain("Uploading 45%");
    expect((screen.getByRole("button", { name: "Remove talking_head.mp4" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      FakeXHR.last!.status = 200;
      FakeXHR.last!.onload!();
    });
    await vi.waitFor(() => expect(h.calls.filter(([k]) => k === "submit")).toHaveLength(1));
  });

  it("an upload that fails part way leaves no half-full bar or percentage behind", async () => {
    render(<CreatorJobsScreen orderId="o1" />);
    await pick([video()]);
    fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await vi.waitFor(() => expect(FakeXHR.last).not.toBeNull());
    act(() => FakeXHR.last!.upload.onprogress!({ lengthComputable: true, loaded: 45, total: 100 }));
    await act(async () => {
      FakeXHR.last!.onerror!();
    });
    await vi.waitFor(() => expect(screen.getByText(/did not finish/)).toBeTruthy());
    const card = screen.getByTestId("picked-file");
    expect(card.textContent).not.toMatch(/Uploading \d+%|Uploaded/);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect((within(card).getByRole("button", { name: "Remove talking_head.mp4" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a file that uploaded but was not sent does not read as delivered", async () => {
    h.submitFails = true;
    render(<CreatorJobsScreen orderId="o1" />);
    await pick([video()]);
    fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));
    await vi.waitFor(() => expect(FakeXHR.last).not.toBeNull());
    await act(async () => {
      FakeXHR.last!.status = 200;
      FakeXHR.last!.onload!();
    });
    await vi.waitFor(() => expect(h.calls.filter(([k]) => k === "submit")).toHaveLength(1));
    await vi.waitFor(() => expect(screen.getByText(/did not finish/)).toBeTruthy());
    expect(screen.getByTestId("picked-file").textContent).not.toContain("Uploaded");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("writes sizes the way people read them", () => {
    expect(fileSize(512)).toBe("1 KB");
    expect(fileSize(12 * 1024 * 1024)).toBe("12.0 MB");
    expect(fileSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("a background refresh that fails while the creator is mid-delivery", () => {
  it("keeps the job, the picked file and the list on screen instead of swapping in an error", async () => {
    render(<CreatorJobsScreen orderId="o1" />);
    const input = await screen.findByTestId("deliver-input");
    fireEvent.change(input, { target: { files: [new File(["x"], "take-1.mp4", { type: "video/mp4" })] } });
    expect(await screen.findByTestId("picked-file")).toBeTruthy();

    h.jobImpl = () => Promise.reject(new Error("network down"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("picked-file").textContent).toContain("take-1.mp4");
    expect(screen.queryByText("That job did not load.")).toBeNull();
    expect(screen.queryByText("Back to your jobs")).toBeNull();
  });
});
