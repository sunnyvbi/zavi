import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const storageMock = vi.hoisted(() => ({ current: null as SupabaseClient["storage"] | null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantStorage: () => storageMock.current,
}));

import {
  ownChatImagePaths,
  signChatPhotos,
  sitePhotoBlockForRefine,
  workspacePhotosNote,
} from "../site-photos";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const OTHER = "73db45ff-457e-4541-bc8f-bdb625390204";
const IMG = "0f0f0f0f-1c87-483f-9930-4a18bc701015";
const CHAT_PATH = `${TENANT}/${IMG}.jpg`;
const FILE = "cd9ec0c2-1c87-483f-9930-4a18bc701015";
const LOCAL_URL = `http://localhost:3011/api/public/workspace-files/${TENANT}/${FILE}/hero.jpeg`;

function fakeStorage() {
  const calls: Array<{ bucket: string; path: string }> = [];
  const from = vi.fn((bucket: string) => ({
    createSignedUrl: vi.fn(async (path: string) => {
      calls.push({ bucket, path });
      return { data: { signedUrl: `https://signed.test/${bucket}/${path}?token=t` }, error: null };
    }),
  }));
  return { storage: { from } as unknown as SupabaseClient["storage"], calls };
}

beforeEach(() => {
  storageMock.current = null;
});

describe("ownChatImagePaths", () => {
  it("keeps only this tenant's well-formed chat image paths, once each", () => {
    expect(
      ownChatImagePaths(TENANT, [
        CHAT_PATH,
        CHAT_PATH,
        `${OTHER}/${IMG}.jpg`,
        `${TENANT}/${IMG}.png`,
        `${TENANT}/../${IMG}.jpg`,
        `../${TENANT}/${IMG}.jpg`,
        42,
        null,
      ]),
    ).toEqual([CHAT_PATH]);
    expect(ownChatImagePaths(TENANT, "not-an-array")).toEqual([]);
  });
});

describe("signChatPhotos", () => {
  it("signs the chat image in the agent-chat-images bucket and never another tenant's", async () => {
    const { storage, calls } = fakeStorage();
    const photos = await signChatPhotos(storage, TENANT, [CHAT_PATH, `${OTHER}/${IMG}.jpg`]);
    expect(calls).toEqual([{ bucket: "agent-chat-images", path: CHAT_PATH }]);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.repoPath).toBe("public/images/chat-photo-0f0f0f0f.jpg");
    expect(photos[0]!.sitePath).toBe("/images/chat-photo-0f0f0f0f.jpg");
  });
});

describe("sitePhotoBlockForRefine", () => {
  it("gives the engineer a download for a chat-attached image even when the request text has no link", async () => {
    const fake = fakeStorage();
    storageMock.current = fake.storage;
    const block = await sitePhotoBlockForRefine(TENANT, "use this image as the hero", "/home/user/repo", [CHAT_PATH]);
    const curl = block.split("\n").find((l) => l.includes("curl"))!;
    expect(curl).toContain("-o '/home/user/repo/public/images/chat-photo-0f0f0f0f.jpg'");
    expect(curl).toContain(`https://signed.test/agent-chat-images/${CHAT_PATH}`);
  });

  it("finds a Files link in the user's own words when the operator's rewrite dropped it, alongside a chat image", async () => {
    const fake = fakeStorage();
    storageMock.current = fake.storage;
    const block = await sitePhotoBlockForRefine(
      TENANT,
      ["Put the uploaded photo in the hero", `Use this photo on the site:\nhero.jpeg: ${LOCAL_URL}`].join("\n"),
      "/home/user/repo",
      [CHAT_PATH],
    );
    expect(fake.calls.map((c) => c.bucket).sort()).toEqual(["agent-chat-images", "tenant-documents"]);
    expect(block.split("\n").filter((l) => l.includes("curl"))).toHaveLength(2);
    expect(block).not.toMatch(/curl[^\n]*localhost/);
  });

  it("renders nothing and signs nothing when there is neither a link nor an attached image", async () => {
    const fake = fakeStorage();
    storageMock.current = fake.storage;
    expect(await sitePhotoBlockForRefine(TENANT, "make the title bigger", "/home/user/repo", [])).toBe("");
    expect(fake.calls).toEqual([]);
  });
});

describe("workspacePhotosNote", () => {
  it("tells the operator a localhost Files link is the user's own photo, not a broken one", () => {
    const note = workspacePhotosNote(TENANT, `Use this photo on the site:\nhero.jpeg: ${LOCAL_URL}`);
    expect(note).toMatch(/linked photos from their workspace Files/);
    expect(note).toMatch(/never tell the user the image is local, broken or out of reach/);
    expect(note).toMatch(/hand the change to the engineer/);
  });

  it("says nothing for a plain message or for another tenant's link", () => {
    expect(workspacePhotosNote(TENANT, "make the title bigger")).toBe("");
    const theirs = LOCAL_URL.replace(TENANT, OTHER);
    expect(workspacePhotosNote(TENANT, `hero: ${theirs}`)).toBe("");
  });
});
