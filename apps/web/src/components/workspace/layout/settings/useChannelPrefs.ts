"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PREF_FIELD, readChannelPrefs, saveChannelPref, type ChannelPrefs } from "@/lib/workspace/channelPrefsApi";

type Key = keyof ChannelPrefs;

const valuesOf = <K extends Key>(key: K, value: ChannelPrefs[K]): string[] => {
  if (key === "notify") {
    const list = value as ChannelPrefs["notify"];
    return list.length ? [...list] : ["none"];
  }
  return [String(value)];
};

export function useChannelPrefs(slug: string) {
  const [prefs, setPrefs] = useState<ChannelPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saved = useRef<ChannelPrefs | null>(null);
  const saveQueue = useRef<Partial<Record<Key, Promise<void>>>>({});
  const saveVersion = useRef<Partial<Record<Key, number>>>({});

  useEffect(() => {
    let live = true;
    setLoadError(null);
    readChannelPrefs(slug)
      .then((p) => {
        if (!live) return;
        saved.current = p;
        setPrefs(p);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  const edit = useCallback(<K extends Key>(key: K, value: ChannelPrefs[K]) => {
    setPrefs((p) => (p ? { ...p, [key]: value } : p));
  }, []);

  const save = useCallback(async <K extends Key>(key: K, value: ChannelPrefs[K]) => {
    if (!saved.current) return;
    const version = (saveVersion.current[key] ?? 0) + 1;
    saveVersion.current[key] = version;
    setError(null);
    setPrefs((p) => (p ? { ...p, [key]: value } : p));
    const run = async () => {
      const before = saved.current;
      if (!before) return;
      try {
        await saveChannelPref(slug, PREF_FIELD[key], valuesOf(key, value));
        saved.current = { ...(saved.current ?? before), [key]: value };
      } catch (e) {
        if (saveVersion.current[key] !== version) return;
        setError((e as Error).message);
        setPrefs((p) => (p ? { ...p, [key]: before[key] } : p));
      }
    };
    const queued = (saveQueue.current[key] ?? Promise.resolve()).then(run);
    saveQueue.current[key] = queued;
    await queued;
    if (saveQueue.current[key] === queued) delete saveQueue.current[key];
  }, [slug]);

  return { prefs, loadError, error, edit, save, retry: () => setAttempt((n) => n + 1) };
}
