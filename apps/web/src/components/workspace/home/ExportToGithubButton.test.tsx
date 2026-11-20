// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  EXPORT_WAIT_INTERVAL_MS,
  EXPORT_WAIT_LIMIT_MS,
  ExportToGithubButton,
  REPO_WATCH_INTERVAL_MS,
  REPO_WATCH_LIMIT_MS,
  UP_TO_DATE_RECHECK_LIMIT_MS,
  REVISION_RECHECK_MS,
  REVISION_RECHECK_TRIES,
  refreshExportStatusAfterEdit,
  UP_TO_DATE_RECHECK_MS,
  prefetchExportStatus,
  resetExportStatusCache,
  __resetExportsInFlight,
} from "./ExportToGithubButton";

const apiFetch = vi.fn();
const postFetch = vi.fn();
const destFetch = vi.fn();
let statusReply: () => unknown = () => ({ ok: true, status: 200, json: async () => ({ ok: true, export: null }) });
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const startConnectFlow = vi.fn();
vi.mock("@/app/connectors/ConnectButton", () => ({ startConnectFlow: (...args: unknown[]) => startConnectFlow(...args) }));

beforeEach(() => {
  apiFetch.mockImplementation((url: string, init?: { method?: string }) =>
    init?.method === "POST"
      ? postFetch(url, init)
      : url.includes("/export-github/dest?")
        ? destFetch(url)
        : Promise.resolve(statusReply()),
  );
  destFetch.mockImplementation(async () => notFound());
});

afterEach(() => {
  cleanup();
  resetExportStatusCache();
  __resetExportsInFlight();
  apiFetch.mockReset();
  postFetch.mockReset();
  destFetch.mockReset();
  startConnectFlow.mockReset();
  statusReply = () => ({ ok: true, status: 200, json: async () => ({ ok: true, export: null }) });
});

function previousExport(full_name = "mohit-upcar/mohit-93bd8436") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      export: {
        full_name,
        url: `https://github.com/${full_name}`,
        branch: "main",
        commit_sha: "c0ffee",
        file_count: 42,
        exported_at: "2026-09-25T07:01:54.000Z",
      },
    }),
  };
}

describe("an export keeps running when the dialog closes", () => {
  function deferred() {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  }

  it("closing the dialog mid-export and reopening it shows Exporting…, then the result when the copy lands", async () => {
    statusReply = previousExport;
    const copy = deferred();
    postFetch.mockReturnValueOnce(copy.promise);
    const view = render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="run-9" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export again" }));
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeTruthy();
    view.unmount();
    render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="run-9" />);
    expect(await screen.findByRole("button", { name: "Exporting…" })).toBeTruthy();
    expect(postFetch).toHaveBeenCalledTimes(1);
    copy.resolve(exported());
    await screen.findByText(/Exported 42 files to/);
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("an export that landed while the dialog was closed is what the reopened dialog shows, with no second export", async () => {
    statusReply = previousExport;
    const copy = deferred();
    postFetch.mockReturnValueOnce(copy.promise);
    const view = render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="run-10" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export again" }));
    view.unmount();
    copy.resolve(exported("mohit-upcar/mohit-93bd8436", true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="run-10" />);
    expect(await screen.findByRole("button", { name: "Up to date" })).toBeTruthy();
    expect(screen.getByTestId("last-export").textContent).toContain("mohit-upcar/mohit-93bd8436");
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("a second Export click while the copy runs joins it instead of starting another", async () => {
    statusReply = previousExport;
    const copy = deferred();
    postFetch.mockReturnValueOnce(copy.promise);
    const view = render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="run-11" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export again" }));
    view.unmount();
    render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="run-11" />);
    await screen.findByRole("button", { name: "Exporting…" });
    copy.resolve(exported());
    await screen.findByText(/Exported 42 files to/);
    expect(postFetch).toHaveBeenCalledTimes(1);
  });
});

describe("ExportToGithubButton when the product was exported before", () => {
  it("says so before any click, links the repo, and never posts an export just to find out", async () => {
    statusReply = previousExport;
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    const line = await screen.findByTestId("last-export");
    expect(line.textContent).toMatch(/Exported to mohit-upcar\/mohit-93bd8436 on .*2026/);
    const link = line.querySelector("a") as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/mohit-upcar/mohit-93bd8436");
    expect(link.target).toBe("_blank");
    expect(screen.getByRole("button", { name: "Export again" })).toBeTruthy();
    expect(postFetch).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/workspace/export-github");
    expect(apiFetch.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("a fresh export replaces the previous-export line with the new result", async () => {
    statusReply = previousExport;
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    await screen.findByTestId("last-export");
    postFetch.mockResolvedValueOnce(exported());
    fireEvent.click(await screen.findByRole("button", { name: "Export again" }));
    await screen.findByText(/Exported 42 files to/);
    expect(screen.queryByTestId("last-export")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("a failed status read leaves the plain popover, with nothing claimed", async () => {
    statusReply = () => ({ ok: false, status: 500, json: async () => ({}) });
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    await flush();
    expect(screen.queryByTestId("last-export")).toBeNull();
    expect(screen.getByRole("button", { name: "Export to GitHub" })).toBeTruthy();
    expect(postFetch).not.toHaveBeenCalled();
  });
});

describe("ExportToGithubButton without a known repo name", () => {
  it("never suggests a repo name the export will not use when the field is left blank", async () => {
    postFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "dest_repo_must_exist",
          message:
            'cannot auto-create "rahu/acme-6ec4d609" under a personal GitHub account. Create a repo named "acme-6ec4d609" under rahu on GitHub (it can be empty), give the Zavi GitHub App access to it, then re-run the export.',
        },
      }),
    });
    render(<ExportToGithubButton />);
    const input = screen.getByRole("textbox", { name: /repo name/i }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toMatch(/leave blank/i);
    expect(input.placeholder).not.toMatch(/^[A-Za-z0-9._-]+$/);

    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    await flush();
    const [, init] = postFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({});
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Create acme-6ec4d609 under rahu/);
  });
});

function missing(owner = "mohit-upcar", repo_name = "mohit-93bd8436") {
  return {
    ok: false,
    status: 409,
    json: async () => ({
      error: {
        code: "dest_repo_must_exist",
        message: `cannot auto-create "${owner}/${repo_name}"`,
        owner,
        repo_name,
        access_url: "https://github.com/settings/installations/164038209",
      },
    }),
  };
}

function notFound() {
  return { ok: true, status: 200, json: async () => ({ ok: true, exists: false }) };
}

function found(full_name = "mohit-upcar/mohit-93bd8436") {
  return { ok: true, status: 200, json: async () => ({ ok: true, exists: true, full_name }) };
}

function exported(full_name = "mohit-upcar/mohit-93bd8436", up_to_date: boolean | null = true) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      exported: true,
      reason: "exported",
      dest: { full_name, url: `https://github.com/${full_name}`, branch: "main", created_repo: false },
      file_count: 42,
      commit_sha: "abc",
      up_to_date,
    }),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

describe("ExportToGithubButton when the repo has to be created on GitHub first", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function reachNeedsRepo(typedName = "mohit-93bd8436") {
    postFetch.mockResolvedValueOnce(missing());
    render(<ExportToGithubButton repoName={typedName} />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    return screen.findByRole("link", { name: /Create mohit-upcar\/mohit-93bd8436 on GitHub/ });
  }

  const destUrls = () => destFetch.mock.calls.map(([u]) => String(u));

  it("opens GitHub's new-repo page prefilled, and starts looking for the repo at once, before the founder clicks anything", async () => {
    const link = (await reachNeedsRepo()) as HTMLAnchorElement;
    const url = new URL(link.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/new");
    expect(url.searchParams.get("name")).toBe("mohit-93bd8436");
    expect(url.searchParams.get("owner")).toBe("mohit-upcar");
    expect(url.searchParams.get("visibility")).toBe("private");
    expect(link.target).toBe("_blank");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Waiting for/)).toBeTruthy();

    await tick(REPO_WATCH_INTERVAL_MS);
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(destFetch).toHaveBeenCalledTimes(2);
    expect(destUrls()[0]).toBe("/api/workspace/export-github/dest?dest_repo_name=mohit-93bd8436");
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("while waiting it shows one line, a spinner and one link to grant the App access", async () => {
    await reachNeedsRepo();
    const watching = screen.getByTestId("repo-watching");
    expect(watching.querySelector(".animate-spin")).not.toBeNull();
    expect(watching.textContent).toBe("Waiting for the repo… Created it? Give the Zavi GitHub App access to it.");
    const access = watching.querySelector("a") as HTMLAnchorElement;
    expect(access.href).toBe("https://github.com/settings/installations/164038209");
    expect(access.target).toBe("_blank");
    expect(screen.getByRole("status").textContent).toMatch(/^Create mohit-upcar\/mohit-93bd8436 on GitHubWaiting for the repo…/);
  });

  it("the moment the repo exists it says Exporting, runs one export, and ends Up to date; a look that fails keeps waiting", async () => {
    const link = await reachNeedsRepo();
    fireEvent.click(link);

    destFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(screen.getByText(/Waiting for/)).toBeTruthy();
    expect(postFetch).toHaveBeenCalledTimes(1);

    const slow = deferred<ReturnType<typeof exported>>();
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockReturnValueOnce(slow.promise);
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(postFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(postFetch.mock.calls[1][1].body)).toEqual({ dest_repo_name: "mohit-93bd8436" });
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeTruthy();
    expect(screen.getByTestId("exporting-note").textContent).toMatch(/can take a minute/);
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    expect((screen.getByRole("textbox", { name: /repo name/i }) as HTMLInputElement).disabled).toBe(true);

    for (let i = 0; i < 5; i++) {
      await tick(REPO_WATCH_INTERVAL_MS);
      act(() => void window.dispatchEvent(new Event("focus")));
    }
    expect(postFetch).toHaveBeenCalledTimes(2);
    const looksBeforeDone = destFetch.mock.calls.length;

    slow.resolve(exported());
    await flush();
    expect(screen.getByRole("status").textContent).toMatch(/Exported 42 files to mohit-upcar\/mohit-93bd8436/);
    expect((screen.getByRole("button", { name: "Up to date" }) as HTMLButtonElement).disabled).toBe(true);
    await tick(REPO_WATCH_INTERVAL_MS * 5);
    expect(postFetch).toHaveBeenCalledTimes(2);
    expect(destFetch.mock.calls.length).toBe(looksBeforeDone);
  });

  it("a repo the look-up sees but the export still cannot (install lag) goes back to waiting, not to an error", async () => {
    await reachNeedsRepo();
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockResolvedValueOnce(missing());
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(postFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Waiting for/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockResolvedValueOnce(exported());
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(screen.getByRole("status").textContent).toMatch(/Exported 42 files/);
  });

  it("every export POST, the click and the watcher's, is sent idempotent so apiFetch may retry a thrown fetch; the reads are not", async () => {
    await reachNeedsRepo();
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockResolvedValueOnce(exported());
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(postFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of postFetch.mock.calls) {
      expect(url).toBe("/api/workspace/export-github");
      expect(init.idempotent).toBe(true);
    }
    const reads = apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method !== "POST");
    expect(reads.length).toBeGreaterThan(1);
    for (const [, init] of reads) expect((init as { idempotent?: boolean } | undefined)?.idempotent).toBeUndefined();
  });

  it("a fetch that throws after the retries surfaces as a network error, not as an export", async () => {
    postFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't reach Zavi/);
    expect(screen.queryByText(/Exported/)).toBeNull();
    expect((screen.getByRole("button", { name: "Export to GitHub" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("typing a different repo name while waiting stops the watch, so the founder can export elsewhere instead of creating that repo", async () => {
    await reachNeedsRepo();
    const input = screen.getByRole("textbox", { name: /repo name/i }) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "other-name" } });
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    expect((screen.getByRole("button", { name: "Export to GitHub" }) as HTMLButtonElement).disabled).toBe(false);
    await tick(REPO_WATCH_INTERVAL_MS * 3);
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(destFetch).not.toHaveBeenCalled();
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("switching to another build stops the repo watcher, so the new build is never exported into the old build's repo", async () => {
    postFetch.mockResolvedValueOnce(missing());
    const { rerender } = render(<ExportToGithubButton repoName="mohit-93bd8436" buildId="11111111-1111-4111-8111-111111111111" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    await screen.findByRole("link", { name: /Create mohit-upcar\/mohit-93bd8436 on GitHub/ });
    rerender(<ExportToGithubButton repoName="mohit-93bd8436" buildId="22222222-2222-4222-8222-222222222222" />);
    await flush();
    destFetch.mockResolvedValue(found());
    await tick(REPO_WATCH_INTERVAL_MS * 3);
    act(() => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(destFetch).not.toHaveBeenCalled();
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("an export still in flight when another build is opened does not drive the new build's popover", async () => {
    const pending = deferred<unknown>();
    postFetch.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<ExportToGithubButton repoName="build-a" buildId="11111111-1111-4111-8111-111111111111" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    rerender(<ExportToGithubButton repoName="build-b" buildId="22222222-2222-4222-8222-222222222222" />);
    await flush();
    expect((screen.getByRole("textbox", { name: /repo name/i }) as HTMLInputElement).value).toBe("build-b");
    await act(async () => pending.resolve(missing()));
    await flush();
    expect(screen.queryByRole("link", { name: /on GitHub/ })).toBeNull();
    await tick(REPO_WATCH_INTERVAL_MS * 3);
    expect(destFetch).not.toHaveBeenCalled();
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("stops polling when the popover closes, even with an export mid-flight", async () => {
    await reachNeedsRepo();
    const slow = deferred<ReturnType<typeof exported>>();
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockReturnValueOnce(slow.promise);
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(postFetch).toHaveBeenCalledTimes(2);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(vi.getTimerCount()).toBe(1);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    slow.resolve(exported());
    await flush();
    await tick(REPO_WATCH_INTERVAL_MS * 10);
    expect(postFetch).toHaveBeenCalledTimes(2);
    expect(destFetch).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("gives up after the watch limit with a way back in, then resumes on 'check again'", async () => {
    await reachNeedsRepo();
    for (let i = 0; i < 12; i++) await tick(REPO_WATCH_INTERVAL_MS);
    expect(destFetch).toHaveBeenCalledTimes(12);
    await tick(REPO_WATCH_LIMIT_MS);
    await tick(REPO_WATCH_INTERVAL_MS);
    const looks = destFetch.mock.calls.length;
    expect(screen.getByText(/Still can't see/)).toBeTruthy();
    const access = screen.getByRole("link", { name: /give the Zavi GitHub App access to it/ }) as HTMLAnchorElement;
    expect(access.href).toBe("https://github.com/settings/installations/164038209");
    await tick(REPO_WATCH_INTERVAL_MS * 3);
    expect(destFetch).toHaveBeenCalledTimes(looks);

    destFetch.mockResolvedValueOnce(found());
    postFetch.mockResolvedValueOnce(exported());
    fireEvent.click(screen.getByRole("button", { name: "check again" }));
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(screen.getByRole("status").textContent).toMatch(/Exported 42 files/);
  });

  it("stops waiting and shows the reason when GitHub refuses for another reason", async () => {
    await reachNeedsRepo();
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "dest_repo_not_empty", message: "has files" } }),
    });
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(screen.getByRole("alert").textContent).toMatch(/Zavi won't overwrite|has files|not empty/i);
    await tick(REPO_WATCH_INTERVAL_MS * 3);
    expect(postFetch).toHaveBeenCalledTimes(2);
    expect(destFetch).toHaveBeenCalledTimes(1);
  });
});

describe("ExportToGithubButton when the GitHub copy already has this build's code", () => {
  const upToDate = () => ({ ...previousExport(), json: async () => ({ ok: true, export: (await previousExport().json()).export, up_to_date: true }) });
  const behind = () => ({ ...previousExport(), json: async () => ({ ok: true, export: (await previousExport().json()).export, up_to_date: false }) });

  it("says so and refuses a pointless re-export; the repo name is shown, not editable, once a copy exists", async () => {
    statusReply = upToDate;
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    const button = (await screen.findByRole("button", { name: "Up to date" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/latest code/)).toBeTruthy();
    fireEvent.click(button);
    expect(postFetch).not.toHaveBeenCalled();

    expect(screen.queryByRole("textbox", { name: /repo name/i })).toBeNull();
    const shown = screen.getByTestId("export-repo-name") as HTMLAnchorElement;
    expect(shown.textContent).toBe("mohit-upcar/mohit-93bd8436");
    expect(shown.href).toBe("https://github.com/mohit-upcar/mohit-93bd8436");
  });

  it("Export again goes to the same repo the first export went to: there is no way to retarget it", async () => {
    statusReply = behind;
    postFetch.mockResolvedValueOnce(exported());
    render(<ExportToGithubButton repoName="typed-something-else" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export again" }));
    await screen.findByRole("button", { name: "Up to date" });
    expect(JSON.parse(postFetch.mock.calls[0][1].body)).toEqual({ dest_repo_name: "mohit-93bd8436" });
  });

  it("offers Export again when the build moved on since the last export, and when the server cannot tell", async () => {
    statusReply = behind;
    const { unmount } = render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    expect(((await screen.findByRole("button", { name: "Export again" })) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    statusReply = previousExport;
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    expect(((await screen.findByRole("button", { name: "Export again" })) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an export that just finished flips the button to Up to date without another status read", async () => {
    postFetch.mockResolvedValueOnce(exported());
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    expect(((await screen.findByRole("button", { name: "Up to date" })) as HTMLButtonElement).disabled).toBe(true);
    expect(apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method !== "POST")).toHaveLength(1);
  });
});

describe("ExportToGithubButton when GitHub is not connected", () => {
  it("offers Connect GitHub right in the popover, wired to the same install flow Settings uses, instead of a link away", async () => {
    postFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "github_not_connected", message: "Connect your own GitHub first." } }),
    });
    let release: () => void = () => undefined;
    startConnectFlow.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    const connect = (await screen.findByTestId("connect-github")) as HTMLButtonElement;
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    fireEvent.click(connect);
    expect(startConnectFlow).toHaveBeenCalledWith("github", { returnHere: true });
    await flush();
    expect((screen.getByTestId("connect-github") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("export-to-github") as HTMLButtonElement).disabled).toBe(true);
    release();
    await flush();
    expect((screen.getByTestId("connect-github") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a connect start that fails says why, in place", async () => {
    postFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "github_not_connected", message: "Connect your own GitHub first." } }),
    });
    startConnectFlow.mockRejectedValueOnce(new Error("start route 500"));
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    fireEvent.click(await screen.findByTestId("connect-github"));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/start route 500/);
  });
});

describe("ExportToGithubButton exports the build that is open", () => {
  const BUILD = "8b282ce4-b91d-4b12-b842-a85cb0f14396";
  const done = {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      exported: true,
      reason: "exported",
      dest: { full_name: "mohit-upcar/cake-shop-2990", url: "https://github.com/mohit-upcar/cake-shop-2990", branch: "main", created_repo: true },
      file_count: 12,
      commit_sha: "c0ffee",
    }),
  };

  it("asks about this build, prefills this build's repo name over the newest app's, and sends the build id", async () => {
    statusReply = () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, export: null, source: "Praxis-build/cake-shop-2990" }),
    });
    postFetch.mockResolvedValue(done);
    render(<ExportToGithubButton repoName="upcoming-cake-1111" buildId={BUILD} />);

    const box = (await screen.findByDisplayValue("cake-shop-2990")) as HTMLInputElement;
    expect(apiFetch.mock.calls[0][0]).toBe(`/api/workspace/export-github?conductor_run_id=${BUILD}`);
    expect(box.value).toBe("cake-shop-2990");

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    });
    const body = JSON.parse(String(postFetch.mock.calls[0][1].body));
    expect(body).toEqual({ dest_repo_name: "cake-shop-2990", conductor_run_id: BUILD });
  });

  it("a build the server refuses (gone from this workspace) says so instead of looking never exported", async () => {
    statusReply = () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "build_session_not_found", message: "build session not found" } }),
    });
    render(<ExportToGithubButton repoName="cake" buildId={BUILD} />);
    expect(await screen.findByText(/isn't in this workspace any more/)).toBeTruthy();
    expect(screen.queryByTestId("last-export")).toBeNull();
    expect(postFetch).not.toHaveBeenCalled();
  });

  it("never overwrites a name the founder already typed", async () => {
    let answer: (v: unknown) => void = () => undefined;
    statusReply = () => new Promise((r) => (answer = r));
    render(<ExportToGithubButton repoName="upcoming-cake-1111" buildId={BUILD} />);
    const box = screen.getByDisplayValue("upcoming-cake-1111") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "my-own-name" } });
    await act(async () => {
      answer({ ok: true, status: 200, json: async () => ({ ok: true, export: null, source: "Praxis-build/cake-shop-2990" }) });
    });
    expect(box.value).toBe("my-own-name");
  });

  it("shows a friendly line, not the server's wording, when a member without admin rights tries", async () => {
    postFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "forbidden", message: "This action requires one of: owner, admin." } }) });
    render(<ExportToGithubButton repoName="cake" buildId={BUILD} />);
    const button = await screen.findByRole("button", { name: "Export to GitHub" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Only workspace owners and admins can export the code/);
  });
});

describe("ExportToGithubButton knows the last status before the founder can click", () => {
  const upToDateReply = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      source: "https://github.com/Praxis-build/crumb-co-01fa30",
      up_to_date: true,
      export: {
        full_name: "mohit-upcar/crumb-co-01fa30",
        url: "https://github.com/mohit-upcar/crumb-co-01fa30",
        branch: "main",
        commit_sha: "c0ffee",
        file_count: 88,
        exported_at: "2026-11-04T09:00:00.000Z",
      },
    }),
  });

  it("the first open never offers an enabled Export while the status is still loading", async () => {
    const slow = deferred<ReturnType<typeof upToDateReply>>();
    statusReply = () => slow.promise;
    render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    const button = screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(postFetch).not.toHaveBeenCalled();
    await act(async () => slow.resolve(upToDateReply()));
    expect((screen.getByRole("button", { name: "Up to date" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closed and reopened, the popover shows Up to date at once from what it already knows, then refreshes", async () => {
    statusReply = upToDateReply;
    const first = render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    await screen.findByRole("button", { name: "Up to date" });
    first.unmount();

    const slow = deferred<ReturnType<typeof upToDateReply>>();
    statusReply = () => slow.promise;
    render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    expect((screen.getByRole("button", { name: "Up to date" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("last-export").textContent).toMatch(/mohit-upcar\/crumb-co-01fa30/);
    expect(screen.queryByRole("button", { name: "Checking…" })).toBeNull();
    await act(async () => slow.resolve(upToDateReply()));
    expect(apiFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/workspace/export-github?"))).toHaveLength(2);
  });

  it("an export just finished is what the next open shows, even before the server is asked again", async () => {
    statusReply = () => ({ ok: true, status: 200, json: async () => ({ ok: true, export: null, source: "https://github.com/Praxis-build/crumb-co-01fa30" }) });
    postFetch.mockResolvedValueOnce(exported("mohit-upcar/crumb-co-01fa30"));
    const first = render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    await screen.findByRole("button", { name: "Up to date" });
    first.unmount();

    statusReply = () => new Promise(() => undefined);
    render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    expect((screen.getByRole("button", { name: "Up to date" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("export-repo-name").textContent).toBe("mohit-upcar/crumb-co-01fa30");
  });

  it("a prefetch from the Build tab makes the very first open instant, and another build's status is never reused", async () => {
    statusReply = upToDateReply;
    await prefetchExportStatus("4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72");
    statusReply = () => new Promise(() => undefined);
    const a = render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    a.unmount();
    render(<ExportToGithubButton repoName="other" buildId="22222222-2222-4222-8222-222222222222" />);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeTruthy();
    expect(screen.queryByTestId("last-export")).toBeNull();
  });
});

describe("ExportToGithubButton never claims more than the server knows", () => {
  it("an export the build outran while it copied ends on Export again, not Up to date, and a reopen agrees", async () => {
    postFetch.mockResolvedValueOnce(exported("mohit-upcar/crumb-co-01fa30", false));
    const first = render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    const again = (await screen.findByRole("button", { name: "Export again" })) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Up to date" })).toBeNull();
    first.unmount();
    statusReply = () => new Promise(() => undefined);
    render(<ExportToGithubButton repoName="crumb-co-01fa30" buildId="4b85e7a4-75b8-4cc1-a2a9-4598c4d37e72" />);
    expect((screen.getByRole("button", { name: "Export again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the workspace app card, which has no build id, never shows a status it fetched for whoever was signed in before", async () => {
    statusReply = () => previousExport("someone-else/their-app");
    const first = render(<ExportToGithubButton />);
    await screen.findByTestId("last-export");
    first.unmount();
    statusReply = () => new Promise(() => undefined);
    render(<ExportToGithubButton />);
    expect(screen.queryByTestId("last-export")).toBeNull();
    expect(screen.queryByText(/someone-else/)).toBeNull();
    expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function inProgress() {
  return {
    ok: false,
    status: 409,
    json: async () => ({ error: { code: "idempotency_in_progress", message: "This request is still being processed." } }),
  };
}

function exportRecordReply(exported_at: string, full_name = "mohit-upcar/mohit-93bd8436", up_to_date: boolean | null = true) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      source: full_name,
      up_to_date,
      export: { full_name, url: `https://github.com/${full_name}`, branch: "main", commit_sha: "abc", file_count: 42, exported_at },
    }),
  };
}

describe("ExportToGithubButton when the retry lands while the first export is still copying", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const statusReads = () => apiFetch.mock.calls.filter(([u, init]) => u === "/api/workspace/export-github" && !init?.method).length;

  it("says Still exporting instead of Export failed, checks the status until the export lands, then shows it as Up to date without a second POST", async () => {
    postFetch.mockResolvedValueOnce(inProgress());
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/failed/i)).toBeNull();
    const still = screen.getByRole("button", { name: "Still exporting…" }) as HTMLButtonElement;
    expect(still.disabled).toBe(true);
    expect(screen.getByTestId("exporting-note").textContent).toMatch(/still copying/i);
    const readsBefore = statusReads();

    await tick(EXPORT_WAIT_INTERVAL_MS);
    await tick(EXPORT_WAIT_INTERVAL_MS);
    expect(statusReads()).toBe(readsBefore + 2);
    expect(screen.getByRole("button", { name: "Still exporting…" })).toBeTruthy();

    statusReply = () => exportRecordReply("2026-11-04T10:00:00.000Z");
    await tick(EXPORT_WAIT_INTERVAL_MS);
    expect(screen.getByRole("status").textContent).toMatch(/Exported 42 files to mohit-upcar\/mohit-93bd8436/);
    expect((screen.getByRole("button", { name: "Up to date" }) as HTMLButtonElement).disabled).toBe(true);
    expect(postFetch).toHaveBeenCalledTimes(1);

    const readsAtDone = statusReads();
    await tick(EXPORT_WAIT_INTERVAL_MS * 5);
    expect(statusReads()).toBe(readsAtDone);
  });

  it("an earlier export is not mistaken for the one in flight: it keeps waiting until the record changes", async () => {
    statusReply = () => exportRecordReply("2026-09-25T07:01:54.000Z", "mohit-upcar/mohit-93bd8436", false);
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    await screen.findByTestId("last-export");
    postFetch.mockResolvedValueOnce(inProgress());
    fireEvent.click(screen.getByRole("button", { name: "Export again" }));
    await flush();
    expect(screen.getByRole("button", { name: "Still exporting…" })).toBeTruthy();

    for (let i = 0; i < 4; i++) await tick(EXPORT_WAIT_INTERVAL_MS);
    expect(screen.getByRole("button", { name: "Still exporting…" })).toBeTruthy();
    expect(screen.queryByText(/Exported 42 files/)).toBeNull();

    statusReply = () => exportRecordReply("2026-11-04T10:00:00.000Z");
    await tick(EXPORT_WAIT_INTERVAL_MS);
    expect(screen.getByRole("status").textContent).toMatch(/Exported 42 files/);
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting after the limit and falls back to what the server knows, never to an error", async () => {
    statusReply = () => exportRecordReply("2026-09-25T07:01:54.000Z", "mohit-upcar/mohit-93bd8436", false);
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    await screen.findByTestId("last-export");
    postFetch.mockResolvedValueOnce(inProgress());
    fireEvent.click(screen.getByRole("button", { name: "Export again" }));
    await flush();
    await tick(EXPORT_WAIT_LIMIT_MS + EXPORT_WAIT_INTERVAL_MS * 2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Still exporting…" })).toBeNull();
    expect((screen.getByRole("button", { name: "Export again" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("last-export")).toBeTruthy();
  });

  it("the repo watcher's export gets the same treatment when its retry lands mid-copy", async () => {
    postFetch.mockResolvedValueOnce(missing());
    render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    await screen.findByRole("link", { name: /Create mohit-upcar\/mohit-93bd8436 on GitHub/ });
    destFetch.mockResolvedValueOnce(found());
    postFetch.mockResolvedValueOnce(inProgress());
    await tick(REPO_WATCH_INTERVAL_MS);
    expect(postFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Still exporting…" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    const looks = destFetch.mock.calls.length;
    statusReply = () => exportRecordReply("2026-11-04T10:00:00.000Z");
    await tick(EXPORT_WAIT_INTERVAL_MS);
    expect(screen.getByRole("status").textContent).toMatch(/Exported 42 files/);
    await tick(REPO_WATCH_INTERVAL_MS * 3);
    expect(destFetch.mock.calls.length).toBe(looks);
    expect(postFetch).toHaveBeenCalledTimes(2);
  });

  it("closing the popover mid-wait stops the status checks", async () => {
    postFetch.mockResolvedValueOnce(inProgress());
    const view = render(<ExportToGithubButton repoName="mohit-93bd8436" />);
    fireEvent.click(await screen.findByRole("button", { name: "Export to GitHub" }));
    await flush();
    await tick(EXPORT_WAIT_INTERVAL_MS);
    const reads = statusReads();
    view.unmount();
    await tick(EXPORT_WAIT_INTERVAL_MS * 4);
    expect(statusReads()).toBe(reads);
  });
});

describe("Up to date keeps looking for new code", () => {
  function upToDateReply(up_to_date: boolean) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        source: "Praxis-build/crumb-co",
        up_to_date,
        export: { full_name: "mohitdudhat22/crumb-co", url: "https://github.com/mohitdudhat22/crumb-co", branch: "main", commit_sha: "c0ffee", source_sha: "s1", file_count: 42, exported_at: "2026-11-05T07:00:00.000Z" },
      }),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an edit that lands after the dialog opened turns Up to date into Export again without reopening", async () => {
    statusReply = () => upToDateReply(true);
    render(<ExportToGithubButton repoName="crumb-co" buildId="run-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("button", { name: "Up to date" }) as HTMLButtonElement).disabled).toBe(true);
    const readsBefore = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UP_TO_DATE_RECHECK_MS);
    });
    expect(apiFetch.mock.calls.length).toBe(readsBefore + 1);
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    statusReply = () => upToDateReply(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UP_TO_DATE_RECHECK_MS);
    });
    const again = screen.getByRole("button", { name: "Export again" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(screen.getByText(/Export again any time to send your latest changes/)).toBeTruthy();
    const readsAfter = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UP_TO_DATE_RECHECK_MS * 4);
    });
    expect(apiFetch.mock.calls.length).toBe(readsAfter);
    expect(postFetch).not.toHaveBeenCalled();
  });

  it("stops rechecking after the limit, and never rechecks without a build id", async () => {
    statusReply = () => upToDateReply(true);
    render(<ExportToGithubButton repoName="crumb-co" buildId="run-2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    const hops = UP_TO_DATE_RECHECK_LIMIT_MS / UP_TO_DATE_RECHECK_MS + 3;
    for (let i = 0; i < hops; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UP_TO_DATE_RECHECK_MS);
      });
    }
    const reads = apiFetch.mock.calls.length;
    expect(reads).toBeGreaterThan(2);
    expect(reads).toBeLessThanOrEqual(1 + UP_TO_DATE_RECHECK_LIMIT_MS / UP_TO_DATE_RECHECK_MS + 1);
    cleanup();
    apiFetch.mockClear();
    render(<ExportToGithubButton repoName="crumb-co" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UP_TO_DATE_RECHECK_MS * 3);
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("a landed edit asks GitHub at once, well before the 5 s tick", async () => {
    statusReply = () => upToDateReply(true);
    const { rerender } = render(<ExportToGithubButton repoName="crumb-co" buildId="run-3" revision="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    const reads = apiFetch.mock.calls.length;
    statusReply = () => upToDateReply(false);
    rerender(<ExportToGithubButton repoName="crumb-co" buildId="run-3" revision="r2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiFetch.mock.calls.length).toBe(reads + 1);
    expect((screen.getByRole("button", { name: "Export again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a landed edit says Export again at once, even while GitHub still reports the old head, and keeps asking until it agrees", async () => {
    statusReply = () => upToDateReply(true);
    const { rerender } = render(<ExportToGithubButton repoName="crumb-co" buildId="run-4" revision="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const reads = apiFetch.mock.calls.length;
    rerender(<ExportToGithubButton repoName="crumb-co" buildId="run-4" revision="r2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiFetch.mock.calls.length).toBe(reads + 1);
    expect((screen.getByRole("button", { name: "Export again" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVISION_RECHECK_MS);
    });
    expect(apiFetch.mock.calls.length).toBe(reads + 2);
    expect(screen.getByRole("button", { name: "Export again" })).toBeTruthy();
    statusReply = () => upToDateReply(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVISION_RECHECK_MS);
    });
    expect(apiFetch.mock.calls.length).toBe(reads + 3);
    const settled = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVISION_RECHECK_MS * REVISION_RECHECK_TRIES);
    });
    expect(apiFetch.mock.calls.length).toBe(settled);
  });

  it("reopened after an edit the server has not caught up with, the dialog still says Export again, not Up to date", async () => {
    statusReply = () => upToDateReply(true);
    render(<ExportToGithubButton repoName="crumb-co" buildId="run-6" revision="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
    cleanup();
    const refresh = refreshExportStatusAfterEdit("run-6");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    render(<ExportToGithubButton repoName="crumb-co" buildId="run-6" revision="r2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("button", { name: "Export again" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Up to date" })).toBeNull();
    statusReply = () => upToDateReply(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVISION_RECHECK_MS * REVISION_RECHECK_TRIES);
    });
    await refresh;
    expect(screen.getByRole("button", { name: "Export again" })).toBeTruthy();
    cleanup();
    statusReply = () => upToDateReply(true);
    render(<ExportToGithubButton repoName="crumb-co" buildId="run-6" revision="r2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: "Up to date" })).toBeTruthy();
  });

  it("the first revision it mounts with is not an edit, and the same revision again is not either", async () => {
    statusReply = () => upToDateReply(true);
    const { rerender } = render(<ExportToGithubButton repoName="crumb-co" buildId="run-5" revision="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const reads = apiFetch.mock.calls.length;
    expect(reads).toBe(1);
    rerender(<ExportToGithubButton repoName="crumb-co" buildId="run-5" revision="r1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVISION_RECHECK_MS * 2);
    });
    expect(apiFetch.mock.calls.length).toBe(reads);
  });
});
