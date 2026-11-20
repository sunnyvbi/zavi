"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const STARTER_PROMPT = "Add these ad suggestions to this client";

export function Composer({
  disabled,
  sending,
  onSend,
  onAddManual,
  prefill,
}: {
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => void;
  onAddManual: () => void;
  prefill?: { id: number; text: string } | null;
}) {
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const lastPrefill = useRef(0);
  const value = text.trim();

  useEffect(() => {
    if (!prefill || prefill.id === lastPrefill.current) return;
    lastPrefill.current = prefill.id;
    setText(prefill.text);
    boxRef.current?.focus();
  }, [prefill]);

  function submit() {
    if (!value || disabled || sending) return;
    setText("");
    onSend(value);
  }

  return (
    <div className="shrink-0 space-y-3 border-t bg-card p-4">
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setText(STARTER_PROMPT)}>
        {STARTER_PROMPT}
      </Button>

      <div className="rounded-2xl border p-2 shadow-sm">
        <Textarea
          ref={boxRef}
          value={text}
          rows={text.includes("\n") ? 5 : 1}
          maxLength={5000}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "Choose a client to start" : "Ask Zavi for growth suggestions…"}
          aria-label="Message Zavi"
          className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
        />

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            disabled={disabled}
            aria-label="Add a suggestion manually"
            onClick={onAddManual}
          >
            <Plus className="size-5" />
          </Button>
          <Button
            size="icon"
            className="size-9 rounded-full"
            disabled={!value || disabled || sending}
            aria-label="Send message"
            onClick={submit}
          >
            <Send className="size-4 fill-current" />
          </Button>
        </div>
      </div>
    </div>
  );
}
