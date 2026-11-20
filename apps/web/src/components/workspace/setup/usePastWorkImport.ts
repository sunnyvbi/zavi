"use client";

import { useEffect, useReducer, useRef } from "react";
import { uploadImport, type ImportReads } from "./importReads";
import { MAX_FILE_MB, MAX_FILES_PER_DROP } from "./importFiles";
import { PAST_WORK_ACCEPT, type PastWorkMode } from "./pastWorkCopy";

export type PastWorkFile = {
  key: string;
  file: File;
  status: "waiting" | "uploading" | "saved" | "failed";
  id?: string;
  reason?: string;
};
type State = {
  text: string;
  savedText: string | null;
  files: PastWorkFile[];
  busy: boolean;
  active: "skip" | "submit" | null;
  error: string | null;
};
type Action =
  | { type: "text"; value: string }
  | { type: "files"; value: PastWorkFile[]; error: string | null }
  | { type: "remove"; key: string }
  | { type: "row"; key: string; patch: Partial<PastWorkFile> }
  | { type: "saving"; active: "skip" | "submit" }
  | { type: "savedText"; value: string }
  | { type: "restore"; text: string; fileNames: string[] }
  | { type: "reset" }
  | { type: "finished"; error: string | null };
const initialState: State = {
  text: "",
  savedText: null,
  files: [],
  busy: false,
  active: null,
  error: null,
};
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return initialState;
    case "text":
      return { ...state, text: action.value, error: null };
    case "files":
      return {
        ...state,
        files: [...state.files, ...action.value],
        error: action.error,
      };
    case "remove":
      return {
        ...state,
        files: state.files.filter((f) => f.key !== action.key),
        error: null,
      };
    case "row":
      return {
        ...state,
        files: state.files.map((f) =>
          f.key === action.key ? { ...f, ...action.patch } : f,
        ),
      };
    case "saving":
      return { ...state, busy: true, active: action.active, error: null };
    case "savedText":
      return { ...state, savedText: action.value };
    case "restore":
      return {
        ...state,
        text: action.text,
        error: action.fileNames.length ? `Sign in again, then reselect: ${action.fileNames.join(", ")}.` : state.error,
      };
    case "finished":
      return { ...state, busy: false, active: null, error: action.error };
  }
}

export function usePastWorkImport(
  imports: ImportReads | null | undefined,
  onComplete: () => Promise<unknown>,
  onSkip: () => Promise<unknown>,
  beforeUpload?: () => Promise<unknown>,
  recoveryKey?: string,
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saving = useRef(false);
  const savedText = useRef<string | null>(null);
  const draft = useRef({ text: "", fileNames: [] as string[] });
  draft.current = { text: state.text, fileNames: state.files.map((row) => row.file.name) };
  const draftKey = useRef<string | null>(null);
  useEffect(() => {
    const owner = draftKey.current;
    if (owner && owner !== recoveryKey) {
      draftKey.current = null;
      draft.current = { text: "", fileNames: [] };
      dispatch({ type: "reset" });
    }
    if (!recoveryKey) return;
    draftKey.current = recoveryKey;
    if (!owner && (draft.current.text || draft.current.fileNames.length)) {
      try { sessionStorage.setItem(recoveryKey, JSON.stringify({ ...draft.current, savedAt: Date.now() })); } catch {}
      return;
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "{}") as { text?: unknown; fileNames?: unknown; savedAt?: unknown };
      if (typeof saved.savedAt !== "number" || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) {
        sessionStorage.removeItem(recoveryKey);
        return;
      }
      dispatch({
        type: "restore",
        text: typeof saved.text === "string" ? saved.text : "",
        fileNames: Array.isArray(saved.fileNames) ? saved.fileNames.filter((name): name is string => typeof name === "string") : [],
      });
    } catch {}
  }, [recoveryKey]);
  const remember = (text: string, fileNames: string[]) => {
    if (!recoveryKey) return;
    try { sessionStorage.setItem(recoveryKey, JSON.stringify({ text, fileNames, savedAt: Date.now() })); } catch {}
  };
  const forget = () => {
    if (!recoveryKey) return;
    try { sessionStorage.removeItem(recoveryKey); } catch {}
  };
  const addFiles = (chosen: readonly File[]) => {
    if (saving.current) return;
    const available = Math.max(0, MAX_FILES_PER_DROP - state.files.length);
    const files = chosen.slice(0, available);
    const valid: PastWorkFile[] = [];
    const errors: string[] =
      chosen.length > available
        ? [`Choose up to ${MAX_FILES_PER_DROP} files at a time.`]
        : [];
    for (const file of files) {
      const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (!PAST_WORK_ACCEPT.split(",").includes(extension))
        errors.push(
          `${file.name}: choose a .md, .txt, .pdf, .docx, .csv or .json file.`,
        );
      else if (file.size > MAX_FILE_MB * 1024 * 1024)
        errors.push(
          `${file.name}: files must be ${MAX_FILE_MB} MB or smaller.`,
        );
      else if (file.size === 0) errors.push(`${file.name} is empty.`);
      else if (
        ![...state.files, ...valid].some(
          (row) =>
            row.file.name === file.name &&
            row.file.size === file.size &&
            row.file.lastModified === file.lastModified,
        )
      )
        valid.push({ key: crypto.randomUUID(), file, status: "waiting" });
    }
    dispatch({
      type: "files",
      value: valid,
      error: errors.length ? errors.join(" ") : null,
    });
    remember(state.text, [...state.files, ...valid].map((row) => row.file.name));
  };
  const run = async (operation: () => Promise<unknown>, active: "skip" | "submit") => {
    if (saving.current) return;
    saving.current = true;
    dispatch({ type: "saving", active });
    try {
      await operation();
      dispatch({ type: "finished", error: null });
    } catch (error) {
      dispatch({
        type: "finished",
        error:
          error instanceof Error
            ? error.message
            : "Couldn't save your past work. Try again.",
      });
    } finally {
      saving.current = false;
    }
  };
  const submit = (mode: PastWorkMode | "auto") =>
    run(async () => {
      await beforeUpload?.();
      const doPaste = (mode === "paste" || mode === "auto") && !!state.text.trim();
      const doFiles = (mode === "files" || mode === "auto") && state.files.length > 0;
      if (doPaste) {
        const text = state.text.trim();
        if (savedText.current !== text) {
          const file = new File([text], "zavi-context.md", {
            type: "text/markdown",
          });
          if (file.size > MAX_FILE_MB * 1024 * 1024)
            throw new Error(
              `Your answer is too large. Keep it under ${MAX_FILE_MB} MB.`,
            );
          const result = await uploadImport(file);
          if (!result.ok)
            throw new Error(
              `Couldn't add your answer: ${result.reason}. Try again.`,
            );
          savedText.current = text;
          dispatch({ type: "savedText", value: text });
          await imports?.refresh();
        }
      }
      if (doFiles) {
        let failed = false;
        for (const row of state.files) {
          if (row.status === "saved") continue;
          dispatch({
            type: "row",
            key: row.key,
            patch: { status: "uploading", reason: undefined },
          });
          const result = await uploadImport(row.file);
          dispatch({
            type: "row",
            key: row.key,
            patch: result.ok
              ? { status: "saved", id: result.id }
              : { status: "failed", reason: result.reason },
          });
          if (!result.ok) failed = true;
        }
        await imports?.refresh();
        if (failed)
          throw new Error(
            "Some files couldn't be added. Retry, remove those files, or skip to continue.",
          );
      }
      if (
        !doPaste &&
        !doFiles &&
        !imports?.files?.length &&
        !state.savedText &&
        !state.files.some((f) => f.status === "saved")
      ) {
        return;
      }
      await onComplete();
      forget();
    }, "submit");
  return {
    ...state,
    addFiles,
    setText: (value: string) => {
      dispatch({ type: "text", value });
      remember(value, state.files.map((row) => row.file.name));
    },
    remove: (key: string) => {
      dispatch({ type: "remove", key });
      remember(state.text, state.files.filter((row) => row.key !== key).map((row) => row.file.name));
    },
    submit,
    skip: () => run(async () => { await onSkip(); forget(); }, "skip"),
  };
}
