"use client";
import { useEffect, useRef, useState } from "react";

type DictationResult = { 0: { transcript: string } };
type DictationEvent = { results: ArrayLike<DictationResult> };
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: DictationEvent) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useIdeaDictation(
  text: string,
  onText: (next: string) => void,
  maxLength: number,
) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const textRef = useRef(text);
  const onTextRef = useRef(onText);
  const written = useRef<string | null>(null);
  textRef.current = text;
  onTextRef.current = onText;

  useEffect(() => {
    if (written.current !== null && text !== written.current) cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    setSupported(recognitionCtor() !== null);
    return () => recognition.current?.abort();
  }, []);

  function start() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    const before = textRef.current.trimEnd();
    const prefix = before ? `${before} ` : "";
    written.current = textRef.current;
    r.onresult = (event) => {
      const heard = Array.from(event.results)
        .map((result) => result[0].transcript.trim())
        .filter(Boolean)
        .join(" ");
      const next = (prefix + heard).slice(0, maxLength);
      written.current = next;
      onTextRef.current(next);
    };
    r.onend = () => {
      recognition.current = null;
      written.current = null;
      setListening(false);
    };
    recognition.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      recognition.current = null;
    }
  }

  function stop() {
    recognition.current?.stop();
  }

  function cancel() {
    written.current = null;
    const r = recognition.current;
    if (!r) return;
    recognition.current = null;
    r.onresult = null;
    r.abort();
    setListening(false);
  }

  return {
    supported,
    listening,
    cancel,
    toggle: () => (listening ? stop() : start()),
  };
}
