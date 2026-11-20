"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  CATEGORY_LABEL,
  PRIORITY_LABEL,
  type SuggestionCategory,
  type SuggestionPriority,
} from "./types";

export type SuggestionEditorValue = {
  title: string;
  body: string;
  category: SuggestionCategory;
  priority: SuggestionPriority;
};

const EMPTY: SuggestionEditorValue = { title: "", body: "", category: "campaign", priority: "medium" };

export function SuggestionEditorModal({
  mode,
  initial,
  busy,
  onClose,
  onSave,
}: {
  mode: "create" | "edit";
  initial?: SuggestionEditorValue;
  busy: boolean;
  onClose: () => void;
  onSave: (value: SuggestionEditorValue) => void;
}) {
  const [value, setValue] = useState<SuggestionEditorValue>(initial ?? EMPTY);
  const valid = value.title.trim().length > 0 && value.body.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create a suggestion" : "Update suggestion"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Write a suggestion by hand instead of generating one."
              : "Update this draft. Changes are saved right away; push it when it is ready."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy) return;
            onSave({ ...value, title: value.title.trim(), body: value.body.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="suggestion-title">Title</Label>
            <Input
              id="suggestion-title"
              autoFocus
              value={value.title}
              maxLength={240}
              placeholder="Protect branded search terms"
              onChange={(event) => setValue((current) => ({ ...current, title: event.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="suggestion-body">Recommendation</Label>
            <Textarea
              id="suggestion-body"
              value={value.body}
              maxLength={5000}
              rows={5}
              placeholder="Explain what the client should consider and why."
              onChange={(event) => setValue((current) => ({ ...current, body: event.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="suggestion-category">Category</Label>
              <Select
                value={value.category}
                onValueChange={(next) =>
                  setValue((current) => ({ ...current, category: next as SuggestionCategory }))
                }
              >
                <SelectTrigger id="suggestion-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABEL).map(([option, label]) => (
                    <SelectItem key={option} value={option}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="suggestion-priority">Priority</Label>
              <Select
                value={value.priority}
                onValueChange={(next) =>
                  setValue((current) => ({ ...current, priority: next as SuggestionPriority }))
                }
              >
                <SelectTrigger id="suggestion-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_LABEL).map(([option, label]) => (
                    <SelectItem key={option} value={option}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? "Saving…" : mode === "create" ? "Save suggestion" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
