import { Directory, Paths } from "expo-file-system";

export const SENT_VIDEO_DIR = "sent-videos";

export function clearSentVideoFiles(): void {
  try {
    const dir = new Directory(Paths.document, SENT_VIDEO_DIR);
    if (dir.exists) dir.delete();
  } catch {
  }
}
