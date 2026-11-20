import { describe, it, expect, vi, beforeEach } from "vitest";

const s = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  calls: [] as Array<{ op: string; args: unknown[] }>,
  owners: [] as string[],
}));
vi.mock("@/services/tenant-client", () => ({
  humanApplicantStorage: (owner: string) => {
    s.owners.push(owner);
    return {
      from: () => ({
        list: async (dir: string, opts: { search: string }) => {
          s.calls.push({ op: "list", args: [dir, opts.search] });
          const p = `${dir}/${opts.search}`;
          const b = s.objects.get(p);
          return { data: b ? [{ name: opts.search, metadata: { size: b.byteLength } }] : [], error: null };
        },
        download: async (p: string) => {
          s.calls.push({ op: "download", args: [p] });
          const b = s.objects.get(p);
          return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } };
        },
        copy: async (a: string, b: string) => {
          s.calls.push({ op: "copy", args: [a, b] });
          s.objects.set(b, s.objects.get(a)!);
          return { data: { path: b }, error: null };
        },
        remove: async (ps: string[]) => {
          s.calls.push({ op: "remove", args: [ps] });
          for (const p of ps) s.objects.delete(p);
          return { data: [], error: null };
        },
        upload: async (p: string) => {
          s.calls.push({ op: "upload", args: [p] });
          return { data: { path: p }, error: null };
        },
        createSignedUrl: async (p: string) => {
          s.calls.push({ op: "sign", args: [p] });
          return { data: { signedUrl: `https://storage.test/object/sign/creator-media/${p}?token=t` }, error: null };
        },
      }),
    };
  },
}));

import { adoptUploadedPhoto, discardUpload, isSavedMediaKey, signCreatorMedia, sniffImageMime, uploadCreatorImage } from "../creator-media";

const AUTH = "11111111-0000-4000-8000-000000000011";
const MEMBER = "55555555-0000-4000-8000-000000000055";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

beforeEach(() => {
  s.objects.clear();
  s.calls.length = 0;
  s.owners.length = 0;
});

describe("sniffImageMime (F4: the file's own signature, not the declared MIME)", () => {
  it("reads JPEG, PNG and WebP signatures", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });
  it("refuses anything else, including a RIFF that is not WEBP", () => {
    expect(sniffImageMime(HTML)).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
  });
});

describe("adoptUploadedPhoto (F1 + F4)", () => {
  it("copies a real image to an identifier-free key and returns it, leaving the upload for the caller to discard after the save", async () => {
    const upload = `${AUTH}/abc.png`;
    s.objects.set(upload, PNG);
    const r = await adoptUploadedPhoto(AUTH, upload);
    expect(r.ok).toBe(true);
    const saved = (r as { path: string }).path;
    expect(isSavedMediaKey(saved)).toBe(true);
    expect(saved).not.toContain(AUTH);
    expect(saved).not.toContain(MEMBER);
    expect(saved.endsWith(".png")).toBe(true);
    expect(s.objects.has(upload)).toBe(true);
    await discardUpload(AUTH, upload);
    expect(s.objects.has(upload)).toBe(false);
    expect(s.owners.every((o) => o === AUTH)).toBe(true);
  });

  it("uses the SNIFFED type for the new key (a JPEG uploaded as .png is saved as .jpg)", async () => {
    s.objects.set(`${AUTH}/x.png`, JPEG);
    const r = await adoptUploadedPhoto(AUTH, `${AUTH}/x.png`);
    expect((r as { path: string }).path.endsWith(".jpg")).toBe(true);
  });

  it("refuses an HTML file declared as an image, without copying it", async () => {
    s.objects.set(`${AUTH}/evil.jpg`, HTML);
    expect(await adoptUploadedPhoto(AUTH, `${AUTH}/evil.jpg`)).toEqual({ ok: false, reason: "not_image" });
    expect(s.calls.some((c) => c.op === "copy")).toBe(false);
  });

  it("refuses over 5 MB and reports a missing upload", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    s.objects.set(`${AUTH}/big.png`, big);
    expect(await adoptUploadedPhoto(AUTH, `${AUTH}/big.png`)).toEqual({ ok: false, reason: "too_large" });
    expect(s.calls.some((c) => c.op === "download" && c.args[0] === `${AUTH}/big.png`)).toBe(false);
    expect(await adoptUploadedPhoto(AUTH, `${AUTH}/gone.png`)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("signCreatorMedia + uploadCreatorImage (F1)", () => {
  it("signs a saved key; the signed URL never carries the auth user id", async () => {
    const url = await signCreatorMedia("media/0b8f5c1e-1111-4111-8111-111111111111.jpg", AUTH);
    expect(url).toMatch(/^https:\/\/storage\.test\//);
    expect(url).not.toContain(AUTH);
  });

  it("refuses to sign an upload key (which carries the auth user id) or a crafted path", async () => {
    expect(await signCreatorMedia(`${AUTH}/abc.png`, AUTH)).toBeNull();
    expect(await signCreatorMedia("media/../x.png", AUTH)).toBeNull();
    expect(s.calls.some((c) => c.op === "sign")).toBe(false);
  });

  it("a generated illustration is stored under an identifier-free key", async () => {
    const key = await uploadCreatorImage(AUTH, PNG, "image/png");
    expect(isSavedMediaKey(key)).toBe(true);
    expect(key).not.toContain(AUTH);
    expect(key).not.toContain(MEMBER);
  });
});
