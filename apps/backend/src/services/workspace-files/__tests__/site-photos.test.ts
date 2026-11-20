import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findWorkspacePhotoRefs,
  renderSitePhotoBlock,
  signSitePhotos,
  sitePhotoFileName,
} from "../site-photos";
import { xmlEscapeContent, sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const OTHER_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const FILE = "cd9ec0c2-1c87-483f-9930-4a18bc701015";
const STORED = "wallpaper-musashi-vagabond-colored-instagram-aesthetic.jpeg";
const LOCAL_URL = `http://localhost:3011/api/public/workspace-files/${TENANT}/${FILE}/${STORED}`;
const SIGNED = "https://wmycgyjsenvgtczlupoe.supabase.co/storage/v1/object/sign/tenant-documents/x?token=abc";

function fakeStorage(fail: Set<string> = new Set()) {
  const createSignedUrl = vi.fn(async (path: string, ttl: number) =>
    fail.has(path)
      ? { data: null, error: { message: "Object not found" } }
      : { data: { signedUrl: `${SIGNED}&p=${encodeURIComponent(path)}&ttl=${ttl}` }, error: null },
  );
  const from = vi.fn(() => ({ createSignedUrl }));
  return { storage: { from } as unknown as SupabaseClient["storage"], from, createSignedUrl };
}

function refineIdea(raw: string): string {
  return xmlEscapeContent(sanitizeFetchedContent(raw));
}

describe("findWorkspacePhotoRefs", () => {
  it("finds the photo in the exact message the refine route stores after sanitising", () => {
    const idea = refineIdea(
      `Can you use this image on our website?\n\nUse the "landing page" photos on the site:\n#wallpaper #musashi #vagabond #colored #instagram #aesthetic.jpeg: ${LOCAL_URL}`,
    );
    expect(findWorkspacePhotoRefs(idea)).toEqual([{ tenantId: TENANT, fileId: FILE, name: STORED }]);
  });

  it("decodes an encoded stored name and dedupes a file linked twice", () => {
    const url = `https://api.zaviagent.com/api/public/workspace-files/${TENANT}/${FILE}/my%20photo.png`;
    expect(findWorkspacePhotoRefs(`${url}\n${url}`)).toEqual([{ tenantId: TENANT, fileId: FILE, name: "my photo.png" }]);
  });

  it("rejects traversal and malformed ids", () => {
    const text = [
      `http://x/api/public/workspace-files/${TENANT}/${FILE}/%2E%2E`,
      `http://x/api/public/workspace-files/${TENANT}/${FILE}/a%2Fb.png`,
      `http://x/api/public/workspace-files/not-a-uuid/${FILE}/a.png`,
    ].join("\n");
    expect(findWorkspacePhotoRefs(text)).toEqual([]);
  });
});

describe("signSitePhotos", () => {
  it("signs the tenant-documents object the public route serves, for the run's own tenant only", async () => {
    const { storage, from, createSignedUrl } = fakeStorage();
    const otherUrl = `http://localhost:3011/api/public/workspace-files/${OTHER_TENANT}/${FILE}/theirs.png`;
    const photos = await signSitePhotos(storage, TENANT, `${LOCAL_URL}\n${otherUrl}`);
    expect(from).toHaveBeenCalledWith("tenant-documents");
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledWith(`${TENANT}/workspace-files/${FILE}/${STORED}`, 3600);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.repoPath).toBe(`public/images/${STORED}`);
    expect(photos[0]!.sitePath).toBe(`/images/${STORED}`);
    expect(photos[0]!.downloadUrl.startsWith(SIGNED)).toBe(true);
  });

  it("drops a photo that can no longer be signed instead of failing the whole run", async () => {
    const second = "0f0f0f0f-1c87-483f-9930-4a18bc701015";
    const { storage } = fakeStorage(new Set([`${TENANT}/workspace-files/${FILE}/${STORED}`]));
    const photos = await signSitePhotos(
      storage,
      TENANT,
      `${LOCAL_URL}\nhttp://localhost:3011/api/public/workspace-files/${TENANT}/${second}/logo.png`,
    );
    expect(photos.map((p) => p.name)).toEqual(["logo.png"]);
  });

  it("keeps two photos with the same name from overwriting each other in public/images", async () => {
    const second = "0f0f0f0f-1c87-483f-9930-4a18bc701015";
    const { storage } = fakeStorage();
    const photos = await signSitePhotos(
      storage,
      TENANT,
      `http://h/api/public/workspace-files/${TENANT}/${FILE}/hero.jpg http://h/api/public/workspace-files/${TENANT}/${second}/hero.jpg`,
    );
    expect(new Set(photos.map((p) => p.repoPath)).size).toBe(2);
  });
});

describe("renderSitePhotoBlock", () => {
  it("hands the engineer a runnable download into the repo and never the unreachable localhost link", async () => {
    const { storage } = fakeStorage();
    const photos = await signSitePhotos(storage, TENANT, LOCAL_URL);
    const block = renderSitePhotoBlock(photos, "/home/user/repo");
    const command = block.split("\n").find((l) => l.includes("curl"))!;
    expect(command).toContain(`-o '/home/user/repo/public/images/${STORED}'`);
    expect(command).toContain(photos[0]!.downloadUrl);
    expect(command).not.toContain("localhost");
    expect(block).toContain(`/images/${STORED}`);
  });

  it("quotes a signed link so a shell cannot split it on & or ;", () => {
    const block = renderSitePhotoBlock(
      [{ name: "a.png", sitePath: "/images/a.png", repoPath: "public/images/a.png", downloadUrl: "https://s/x?token=a&b=c;rm -rf /" }],
      "/home/user/repo",
    );
    expect(block).toContain(`'https://s/x?token=a&b=c;rm -rf /'`);
  });

  it("tells the engineer the photos are the user's to use, with no rights questions or refusals", async () => {
    const { storage } = fakeStorage();
    const block = renderSitePhotoBlock(await signSitePhotos(storage, TENANT, LOCAL_URL), "/home/user/repo");
    for (const w of ["copyright", "licensing", "own it", "who made it", "never refuse"]) expect(block).toContain(w);
  });

  it("renders nothing when there are no photos", () => {
    expect(renderSitePhotoBlock([], "/home/user/repo")).toBe("");
  });
});

describe("sitePhotoFileName", () => {
  it("makes a URL-safe file name and keeps the extension", () => {
    expect(sitePhotoFileName("#wallpaper #musashi (1).JPEG", FILE)).toBe("wallpaper-musashi-1.jpeg");
    expect(sitePhotoFileName("###.png", FILE)).toBe("photo-cd9ec0c2.png");
  });
});

describe("the notes that stop the operator from blocking a user's own image", () => {
  const OWNER = "11111111-aaaa-aaaa-aaaa-111111111111";
  const OTHER = "99999999-9999-9999-9999-999999999999";
  const IMG = "55555555-eeee-eeee-eeee-555555555555";
  const RIGHTS_WORDS = ["copyright", "licensing", "own it", "who made it"];

  it("an attached chat photo gets a note that forbids rights questions and re-upload asks", async () => {
    const { attachedPhotosNote } = await import("../site-photos");
    const note = attachedPhotosNote(OWNER, [`${OWNER}/${IMG}.jpg`]);
    expect(note.startsWith("[Note from Zavi, not the user: the user attached a photo")).toBe(true);
    for (const w of RIGHTS_WORDS) expect(note).toContain(w);
    expect(note).toContain("never ask them to send it again");
    expect(note).toContain("hand the change to the engineer");
    expect(attachedPhotosNote(OWNER, [`${OWNER}/${IMG}.jpg`, `${OWNER}/${OTHER}.jpg`])).toContain("attached 2 photos");
  });

  it("a photo under another tenant, a malformed path, or no photo yields no note", async () => {
    const { attachedPhotosNote } = await import("../site-photos");
    expect(attachedPhotosNote(OWNER, [`${OTHER}/${IMG}.jpg`])).toBe("");
    expect(attachedPhotosNote(OWNER, [`${OWNER}/../${IMG}.jpg`, `${OWNER}/${IMG}.png`])).toBe("");
    expect(attachedPhotosNote(OWNER, [])).toBe("");
    expect(attachedPhotosNote(OWNER, undefined)).toBe("");
  });

  it("a workspace Files link note carries the same no-rights-questions rule", async () => {
    const { workspacePhotosNote } = await import("../site-photos");
    const note = workspacePhotosNote(OWNER, `use http://localhost:3011/api/public/workspace-files/${OWNER}/${IMG}/hero.jpg on my landing page`);
    for (const w of RIGHTS_WORDS) expect(note).toContain(w);
    expect(note).toContain("never ask them to upload it again");
    expect(workspacePhotosNote(OWNER, `http://localhost:3011/api/public/workspace-files/${OTHER}/${IMG}/hero.jpg`)).toBe("");
  });
});
