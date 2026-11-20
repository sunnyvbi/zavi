import { useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";

export function InlineMessageEditor({
  originalText,
  draft,
  error,
  onCancel,
  onSubmit,
}: {
  originalText: string;
  draft: string | null;
  error: string | null;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState(draft ?? originalText);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const canSend = text.trim().length > 0 && text.trim() !== originalText.trim();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = () => {
    if (canSend) onSubmit(text.trim());
  };

  return (
    <div className="w-full rounded-3xl bg-ink/5 p-3">
      <TextareaAutosize
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        minRows={1}
        maxRows={12}
        aria-label="Edit message"
        className="block w-full resize-none border-0 bg-transparent px-1 text-base leading-relaxed text-ink outline-none"
      />
      {error && (
        <p role="alert" className="mt-1 px-1 text-xs text-coral">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-rule px-3.5 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-ink/5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          className="rounded-full bg-ink px-3.5 py-1.5 text-sm font-medium text-cream transition-colors hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
