import { useCallback, useState } from "react";
import { File, Paths } from "expo-file-system";
import { apiUrl } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import type { MediaItem } from "../../components/MediaViewer";

const fail = "The video did not load. Try again.";

export function useIntroVideo(memberId: string, name: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<MediaItem | null>(null);

  const play = useCallback(async () => {
    if (busy || !memberId) return;
    setBusy(true);
    setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error(fail);
      const file = await File.downloadFileAsync(apiUrl(`/api/humans/creators/${encodeURIComponent(memberId)}/intro-video`), new File(Paths.cache, `intro-${memberId}.mp4`), {
        headers: { Authorization: `Bearer ${token}` },
        idempotent: true,
      });
      setItem({ kind: "video", url: file.uri, filename: `${name}'s intro` });
    } catch {
      setError(fail);
    } finally {
      setBusy(false);
    }
  }, [busy, memberId, name]);

  return { play, busy, error, item, close: () => setItem(null) };
}
