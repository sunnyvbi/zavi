import type { VideoThumbnail } from "expo-video";
import { inAppVideoAvailable } from "../../components/MediaViewer";
import { fetchArtifactPreviewUrl } from "./api";

const cache = new Map<string, VideoThumbnail | null>();
const pending = new Map<string, Promise<VideoThumbnail | null>>();
let tail: Promise<unknown> = Promise.resolve();

const READY_TIMEOUT_MS = 8000;

async function grab(id: string): Promise<VideoThumbnail | null> {
  if (!inAppVideoAvailable()) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createVideoPlayer } = require("expo-video") as typeof import("expo-video");
  const { signed_url } = await fetchArtifactPreviewUrl(id);
  const player = createVideoPlayer(signed_url);
  try {
    await new Promise<void>((resolve, reject) => {
      if (player.status === "readyToPlay") {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("timeout")), READY_TIMEOUT_MS);
      const sub = player.addListener("statusChange", ({ status }) => {
        if (status === "readyToPlay") {
          clearTimeout(timer);
          sub.remove();
          resolve();
        } else if (status === "error") {
          clearTimeout(timer);
          sub.remove();
          reject(new Error("video error"));
        }
      });
    });
    const [thumb] = await player.generateThumbnailsAsync([0.5], { maxWidth: 480 });
    return thumb ?? null;
  } finally {
    player.release();
  }
}

export function loadVideoThumbnail(id: string): Promise<VideoThumbnail | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  const running = pending.get(id);
  if (running) return running;
  const job = tail
    .catch(() => undefined)
    .then(() => grab(id))
    .catch(() => null)
    .then((thumb) => {
      cache.set(id, thumb);
      pending.delete(id);
      return thumb;
    });
  tail = job;
  pending.set(id, job);
  return job;
}

export function cachedVideoThumbnail(id: string): VideoThumbnail | null | undefined {
  return cache.get(id);
}
