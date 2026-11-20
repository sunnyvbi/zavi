import { useState } from "react";

export function usePostEditing(text: string, onSave?: (text: string) => Promise<void>) {
  const [state, setState] = useState({ editing: false, saving: false, error: "" });
  const toggle = async () => {
    if (state.saving) return;
    if (!state.editing) {
      setState({ editing: true, saving: false, error: "" });
      return;
    }
    if (!onSave) {
      setState({ editing: false, saving: false, error: "" });
      return;
    }
    setState({ editing: true, saving: true, error: "" });
    try {
      await onSave?.(text);
      setState({ editing: false, saving: false, error: "" });
    } catch (error) {
      setState({ editing: true, saving: false, error: error instanceof Error ? error.message : "Could not save the draft. Try again." });
    }
  };
  const cancel = () => { if (!state.saving) setState({ editing: false, saving: false, error: "" }); };
  return { ...state, toggle, cancel };
}
