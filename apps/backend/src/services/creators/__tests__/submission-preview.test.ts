import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFfmpegCommand,
  buildSubmissionPreviews,
  isPaidOrder,
  previewGaveUp,
  previewMedia,
  previewNeedsWork,
  previewPathFor,
  type PreviewSandbox,
  type PreviewStore,
  type PreviewSubmissionRow,
} from "../submission-preview";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-10-07T12:00:00.000Z");

function row(over: Partial<PreviewSubmissionRow> = {}): PreviewSubmissionRow {
  return {
    id: "sub-1",
    tenant_id: TENANT,
    order_id: ORDER,
    version: 1,
    storage_path: `${TENANT}/${ORDER}/orig-1.mov`,
    mime_type: "video/quicktime",
    preview_path: null,
    preview_state: null,
    preview_updated_at: null,
    ...over,
  };
}

type Mark = { id: string; preview_state: string; preview_path: string | null; preview_error: string | null };

function harness(opts: {
  order?: { status: string; closed_reason: string | null } | null;
  rows?: PreviewSubmissionRow[];
  ffmpegFails?: (command: string) => boolean;
  depsMissing?: boolean;
  openFails?: boolean;
  openDispute?: boolean;
}) {
  const marks: Mark[] = [];
  const uploads: Array<{ tenant_id: string; path: string; contentType: string; bytes: number }> = [];
  const commands: Array<{ command: string; env?: Record<string, string> }> = [];
  const signed: string[] = [];
  let opened = 0;
  let closed = 0;
  const order = opts.order === undefined ? { status: "submitted", closed_reason: null } : opts.order;
  const store: PreviewStore = {
    loadOrder: async (id) => (order ? { id, tenant_id: TENANT, ...order } : null),
    hasOpenDispute: async (tenant_id, order_id) => {
      expect([tenant_id, order_id]).toEqual([TENANT, ORDER]);
      return opts.openDispute === true;
    },
    listVersion: async (tenant_id, order_id, version) => {
      expect([tenant_id, order_id]).toEqual([TENANT, ORDER]);
      return (opts.rows ?? [row()]).filter((r) => r.version === version);
    },
    mark: async (r, patch) => {
      marks.push({ id: r.id, ...patch });
    },
    signSource: async (tenant_id, path) => {
      signed.push(path);
      return `https://storage.test/sign/${path}?token=SECRET-${tenant_id}`;
    },
    upload: async (tenant_id, path, bytes, contentType) => {
      uploads.push({ tenant_id, path, contentType, bytes: bytes.byteLength });
    },
  };
  const sandbox: PreviewSandbox = {
    open: async () => {
      if (opts.openFails) throw new Error("e2b quota");
      opened += 1;
      return "sbx-1";
    },
    exec: async (_id, command, _t, env) => {
      commands.push({ command, env });
      if (command.includes("echo OK || echo MISSING")) {
        return { stdout: opts.depsMissing ? "MISSING" : "OK", stderr: "", exit_code: 0, ms: 1, timed_out: false };
      }
      if (command.startsWith("ffmpeg") && opts.ffmpegFails?.(command)) {
        return { stdout: "", stderr: "Invalid data found when processing input", exit_code: 1, ms: 1, timed_out: false };
      }
      return { stdout: "", stderr: "", exit_code: 0, ms: 1, timed_out: false };
    },
    readBytes: async () => new Uint8Array([1, 2, 3]),
    close: async () => {
      closed += 1;
    },
  };
  return { store, sandbox, marks, uploads, commands, signed, opened: () => opened, closed: () => closed };
}

describe("buildSubmissionPreviews", () => {
  it("watermarks into the preview folder and never writes over the creator's original", async () => {
    const h = harness({
      rows: [row(), row({ id: "sub-2", storage_path: `${TENANT}/${ORDER}/orig-2.png`, mime_type: "image/png" })],
    });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);

    expect(r.ready).toEqual(["sub-1", "sub-2"]);
    expect(h.uploads).toEqual([
      { tenant_id: TENANT, path: `${TENANT}/${ORDER}/preview/sub-1.mp4`, contentType: "video/mp4", bytes: 3 },
      { tenant_id: TENANT, path: `${TENANT}/${ORDER}/preview/sub-2.jpg`, contentType: "image/jpeg", bytes: 3 },
    ]);
    expect(h.uploads.some((u) => u.path.includes("orig-"))).toBe(false);
    expect(h.marks.filter((m) => m.preview_state === "ready").map((m) => m.preview_path)).toEqual([
      `${TENANT}/${ORDER}/preview/sub-1.mp4`,
      `${TENANT}/${ORDER}/preview/sub-2.jpg`,
    ]);
    expect(h.opened()).toBe(1);
    expect(h.closed()).toBe(1);
  });

  it("hands the signed source link to the sandbox as an env value, never inside the command text", async () => {
    const h = harness({});
    await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    const fetch = h.commands.find((c) => c.command.includes("curl"))!;
    expect(fetch.env?.SOURCE_URL).toContain("SECRET-");
    expect(h.commands.every((c) => !c.command.includes("SECRET-"))).toBe(true);
  });

  it("does no work and opens no sandbox once the job is paid", async () => {
    const h = harness({ order: { status: "completed", closed_reason: "approved" } });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(r.skipped).toBe("order_paid");
    expect(h.opened()).toBe(0);
    expect(h.marks).toEqual([]);
  });

  it.each(["auto_accepted", "approved"] as const)(
    "builds the watermarked preview for a %s job while Zavi is looking at an open dispute on it",
    async (closed_reason) => {
      const h = harness({ order: { status: "completed", closed_reason }, openDispute: true });
      const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
      expect(r.skipped).toBeUndefined();
      expect(r.ready).toEqual(["sub-1"]);
      expect(h.uploads.map((u) => u.path)).toEqual([`${TENANT}/${ORDER}/preview/sub-1.mp4`]);
    },
  );

  it("leaves a preview another worker is building right now alone, and redoes a stuck one", async () => {
    const h = harness({
      rows: [
        row({ id: "busy", preview_state: "pending", preview_updated_at: new Date(NOW.getTime() - 60_000).toISOString() }),
        row({ id: "stuck", preview_state: "pending", preview_updated_at: new Date(NOW.getTime() - 3_600_000).toISOString() }),
        row({ id: "done", preview_state: "ready", preview_path: `${TENANT}/${ORDER}/preview/done.mp4` }),
      ],
    });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(r.ready).toEqual(["stuck"]);
    expect(new Set(h.marks.map((m) => m.id))).toEqual(new Set(["stuck"]));
  });

  it("fails one file without failing the others, and never marks a broken file ready", async () => {
    const h = harness({
      rows: [row({ id: "bad" }), row({ id: "good", storage_path: `${TENANT}/${ORDER}/orig-2.mp4`, mime_type: "video/mp4" })],
      ffmpegFails: () => h.commands.filter((c) => c.command.startsWith("ffmpeg")).length === 1,
    });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(r.failed).toEqual([{ id: "bad", code: "watermark_failed" }]);
    expect(r.ready).toEqual(["good"]);
    expect(h.uploads.map((u) => u.path)).toEqual([`${TENANT}/${ORDER}/preview/good.mp4`]);
    expect(h.marks.filter((m) => m.id === "bad").map((m) => m.preview_state)).toEqual(["pending", "failed"]);
    expect(h.closed()).toBe(1);
  });

  it("fails closed when ffmpeg or the font is missing: nothing uploaded, nothing ready", async () => {
    const h = harness({ depsMissing: true });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(r.failed).toEqual([{ id: "sub-1", code: "watermark_deps_missing" }]);
    expect(h.uploads).toEqual([]);
    expect(h.marks.some((m) => m.preview_state === "ready")).toBe(false);
    expect(h.closed()).toBe(1);
  });

  it("marks every file failed when no sandbox can be had", async () => {
    const h = harness({ openFails: true, rows: [row({ id: "a" }), row({ id: "b" })] });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(r.failed.map((f) => f.id)).toEqual(["a", "b"]);
    expect(h.marks.filter((m) => m.preview_state === "failed").map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("a file is worked on one at a time, and a file that keeps failing stops", () => {
  it("marks a file pending only when its turn comes, and counts the attempt", async () => {
    const h = harness({ rows: [row({ id: "a" }), row({ id: "b", preview_state: "failed", preview_attempts: 1 } as Partial<PreviewSubmissionRow>)] });
    await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(h.marks.map((m) => `${m.id}:${m.preview_state}`)).toEqual(["a:pending", "a:ready", "b:pending", "b:ready"]);
    expect((h.marks[0] as Mark & { preview_attempts?: number }).preview_attempts).toBe(1);
    expect((h.marks[2] as Mark & { preview_attempts?: number }).preview_attempts).toBe(2);
  });

  it("gives up after three failed attempts: no sandbox, no more retries", async () => {
    const h = harness({ rows: [row({ preview_state: "failed", preview_attempts: 3 } as Partial<PreviewSubmissionRow>)] });
    const r = await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, h.store, h.sandbox);
    expect(r.skipped).toBe("nothing_to_do");
    expect(h.opened()).toBe(0);
    expect(previewGaveUp({ preview_state: "failed", preview_attempts: 3 })).toBe(true);
    expect(previewNeedsWork({ preview_state: "failed", preview_attempts: 2, preview_updated_at: null }, NOW)).toBe(true);
  });

  it("an attempt cut off mid-way (a killed worker leaves it pending) still counts: the cap holds for every state", () => {
    const stale = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const cutOff = { preview_state: "pending" as const, preview_attempts: 3, preview_updated_at: stale };
    expect(previewNeedsWork(cutOff, NOW)).toBe(false);
    expect(previewGaveUp(cutOff, NOW)).toBe(true);
    const running = { ...cutOff, preview_updated_at: NOW.toISOString() };
    expect(previewGaveUp(running, NOW)).toBe(false);
    expect(previewNeedsWork({ ...cutOff, preview_attempts: 2 }, NOW)).toBe(true);
  });

  it.each([
    ["the sandbox cannot be opened", { openFails: true }, "sandbox_failed"],
    ["ffmpeg cannot be installed", { depsMissing: true }, "watermark_deps_missing"],
  ] as const)("stops requeueing when %s on every try, so an outage cannot loop sandboxes forever", async (_name, failure, code) => {
    const db = new Map<string, PreviewSubmissionRow>([
      ["a", row({ id: "a" })],
      ["b", row({ id: "b", storage_path: `${TENANT}/${ORDER}/orig-b.png`, mime_type: "image/png" })],
    ]);
    const h = harness({ ...failure });
    let tries = 0;
    const store: PreviewStore = {
      ...h.store,
      listVersion: async () => [...db.values()].map((r) => ({ ...r })),
      mark: async (r, patch) => {
        db.set(r.id, { ...db.get(r.id)!, ...patch, preview_updated_at: NOW.toISOString() });
      },
    };
    const sandbox: PreviewSandbox = {
      ...h.sandbox,
      open: async (tenant_id) => {
        tries += 1;
        return h.sandbox.open(tenant_id);
      },
    };

    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await buildSubmissionPreviews({ order_id: ORDER, version: 1, now: NOW }, store, sandbox));

    expect(runs.slice(0, 3).map((r) => r.failed)).toEqual(Array(3).fill([{ id: "a", code }, { id: "b", code }]));
    expect(runs.slice(3).map((r) => r.skipped)).toEqual(["nothing_to_do", "nothing_to_do", "nothing_to_do"]);
    expect(tries).toBe(3);
    for (const r of db.values()) {
      expect(r.preview_attempts).toBe(3);
      expect(previewGaveUp(r)).toBe(true);
    }
  });

  it("ffmpeg only reads the local file and the optional audio map is quoted", () => {
    for (const media of ["video", "image"] as const) expect(buildFfmpegCommand(media)).toContain("-protocol_whitelist file -i");
    expect(buildFfmpegCommand("video")).toContain("-map '0:a:0?'");
    expect(buildFfmpegCommand("video")).toContain("trunc(min(1920,iw)/2)*2");
  });
});

describe("what counts as paid", () => {
  it.each([
    ["completed", "approved", true],
    ["completed", "auto_accepted", true],
    ["completed", "mediation_pay_full", true],
    ["completed", "mediation_pay_part", true],
    ["completed", "mediation_refund", false],
    ["cancelled", "cancel_agreed", false],
    ["submitted", null, false],
    ["in_dispute", null, false],
  ] as const)("%s / %s -> %s", (status, closed_reason, paid) => {
    expect(isPaidOrder({ status, closed_reason })).toBe(paid);
  });

  it("knows a video or an image from the mime, or from the file name when the mime is missing", () => {
    expect(previewMedia("video/webm", "x/y/a.webm")).toBe("video");
    expect(previewMedia(null, "x/y/a.MOV")).toBe("video");
    expect(previewMedia(null, "x/y/a.jpeg")).toBe("image");
    expect(previewMedia("application/pdf", "x/y/a.pdf")).toBeNull();
    expect(previewPathFor(row({ id: "s9" }), "image")).toBe(`${TENANT}/${ORDER}/preview/s9.jpg`);
  });
});

const FFMPEG = process.env.FFMPEG_TEST_BIN;
const FONT = process.env.FFMPEG_TEST_FONT;

describe.skipIf(!FFMPEG || !FONT)("the real ffmpeg filter burns a visible mark into the frame", () => {
  function run(command: string, dir: string) {
    const local = command
      .replace(/^ffmpeg/, `"${FFMPEG}"`)
      .split("/home/user/preview").join(dir)
      .split("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf").join(FONT!.replace(/:/g, "\\\\:"));
    execSync(local, { stdio: "pipe" });
  }
  function centreGray(file: string, dir: string, w: number, h: number): number {
    const raw = join(dir, "frame.gray");
    execFileSync(FFMPEG!, ["-y", "-loglevel", "error", "-i", file, "-vf", `scale=${w}:${h}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const px = readFileSync(raw);
    let max = 0;
    for (let y = Math.floor(h * 0.4); y < Math.floor(h * 0.6); y++) {
      for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x++) max = Math.max(max, px[y * w + x]);
    }
    return max;
  }

  it.each([
    ["portrait video", "video", "1080x1920", "mp4"],
    ["landscape video", "video", "1920x1080", "mp4"],
    ["odd-width video", "video", "1081x1921", "mp4"],
    ["image", "image", "1200x1200", "jpg"],
  ] as const)("%s", (_name, media, size, ext) => {
    const dir = mkdtempSync(join(tmpdir(), "wm-"));
    const src = media === "video" ? ["-f", "lavfi", "-i", `color=c=black:s=${size}:d=1`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4"] : ["-f", "lavfi", "-i", `color=c=black:s=${size}`, "-frames:v", "1", "-f", "image2", "-c:v", "png"];
    execFileSync(FFMPEG!, ["-y", "-loglevel", "error", ...src, join(dir, "in")]);
    const [w, h] = size.split("x").map((n) => Number(n) - (Number(n) % 4));

    expect(centreGray(join(dir, "in"), dir, w / 4, h / 4)).toBeLessThan(20);
    run(buildFfmpegCommand(media), dir);
    expect(centreGray(join(dir, `out.${ext}`), dir, w / 4, h / 4)).toBeGreaterThan(60);
  });
});
