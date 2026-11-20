import { useEffect, useState, type JSX } from "react";
import { SendIcon } from "./icons";

type Props = {
  busy: boolean;
  onSend: (text: string) => void | Promise<void>;
  restore?: string | null;
  onRestored?: () => void;
  onTextChange?: (text: string) => void;
};

export function Composer(props: Props): JSX.Element {
  const [text, setTextState] = useState("");
  const { onTextChange } = props;
  const setText = (next: string): void => {
    setTextState(next);
    onTextChange?.(next);
  };
  const canSend = text.trim().length > 0 && !props.busy;

  const { restore, onRestored } = props;
  useEffect(() => {
    if (restore === null || restore === undefined || restore === "") return;
    setText(restore);
    onRestored?.();
  }, [restore, onRestored]);

  function submit(): void {
    if (!canSend) return;
    const body = text;
    setText("");
    void props.onSend(body);
  }

  return (
    <form
      className="zv-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="zv-field">
        <textarea
          className="zv-input"
          value={text}
          rows={2}
          placeholder="Ask about this tab..."
          aria-label="Ask Zavi about this page"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          className="zv-send"
          disabled={!canSend}
          aria-label="Send"
        >
          <SendIcon />
        </button>
      </div>
    </form>
  );
}
