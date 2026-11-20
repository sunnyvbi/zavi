import { useState } from "react";
import type { PostImageSize, SavedPostDraft } from "@zavi/shared";
import type { PostPhotoValues } from "./PostPhotoFields";

export function usePostPhoto(content: SavedPostDraft | null) {
  const initial = { image_path: content?.image_path, size: content?.size, headline: content?.headline, rendered_image_path: content?.rendered_image_path };
  const [state, setState] = useState<{ value: PostPhotoValues & { rendered_image_path?: string }; snapshot: PostPhotoValues & { rendered_image_path?: string }; busy: boolean }>({ value: initial, snapshot: initial, busy: false });
  return {
    ...state,
    change: (value: PostPhotoValues & { rendered_image_path?: string }) => setState((old) => ({ ...old, value: { ...value, rendered_image_path: value.rendered_image_path } })),
    begin: (image = false, size: PostImageSize = "feed") => setState((old) => ({ ...old, snapshot: old.value, value: image ? { ...old.value, size: old.value.size ?? size } : old.value })),
    cancel: () => setState((old) => ({ ...old, value: old.snapshot })),
    reset: () => setState((old) => ({ ...old, value: { image_path: undefined, size: undefined, headline: undefined, rendered_image_path: undefined } })),
    setBusy: (busy: boolean) => setState((old) => ({ ...old, busy })),
  };
}
