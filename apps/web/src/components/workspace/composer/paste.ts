type PasteLike = {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
};

export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function handleTextareaPaste(event: PasteLike, onFiles: (files: File[]) => void) {
  const files = pastedImageFiles(event.clipboardData);
  if (files.length === 0) return;
  if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
  onFiles(files);
}
