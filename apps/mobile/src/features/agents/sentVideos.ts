import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { SENT_VIDEO_DIR as DIR } from "./sentVideoFiles";

export type SentVideo = { file: string; name: string };
type SentVideoMap = Record<string, SentVideo>;

const storageKey = (tenant: string) => `zavi.sentVideos.${tenant}`;
const queryKey = (tenant: string) => ["sent-videos", tenant] as const;

const MAX_ENTRIES = 30;

const videoDir = () => new Directory(Paths.document, DIR);

export function sentVideoUri(video: SentVideo): string {
  return new File(Paths.document, DIR, video.file).uri;
}

export function sentVideoPlayable(video: SentVideo): boolean {
  try {
    return typeof video.file === "string" && new File(Paths.document, DIR, video.file).exists;
  } catch {
    return false;
  }
}

export function useSentVideos() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: queryKey(tenant),
    enabled: tenant !== "none",
    staleTime: Infinity,
    queryFn: async (): Promise<SentVideoMap> => {
      try {
        const raw = await AsyncStorage.getItem(storageKey(tenant));
        const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, Partial<SentVideo>>;
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (e): e is [string, SentVideo] => typeof e[1]?.file === "string",
          ),
        );
      } catch {
        return {};
      }
    },
  });
}

export function useRememberSentVideo() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: async ({
      messageId,
      localUri,
      name,
    }: {
      messageId: string;
      localUri: string;
      name: string;
    }) => {
      const ext = (localUri.split(".").pop() ?? "mov").toLowerCase().slice(0, 5);
      const fileName = `${messageId}.${ext}`;
      const dir = videoDir();
      dir.create({ idempotent: true, intermediates: true });
      const dest = new File(Paths.document, DIR, fileName);
      if (!dest.exists) await new File(localUri).copy(dest);

      const prev = qc.getQueryData<SentVideoMap>(queryKey(tenant)) ?? {};
      const entries = Object.entries({ ...prev, [messageId]: { file: fileName, name } });
      const kept = entries.slice(-MAX_ENTRIES);
      for (const [, v] of entries.slice(0, entries.length - kept.length)) {
        try {
          new File(Paths.document, DIR, v.file).delete();
        } catch {
        }
      }
      const next = Object.fromEntries(kept);
      qc.setQueryData(queryKey(tenant), next);
      await AsyncStorage.setItem(storageKey(tenant), JSON.stringify(next)).catch(() => {});
      return next;
    },
  });
}
