"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type RecognitionAlternative = { transcript: string };

type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
};

type RecognitionResultList = {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
};

type RecognitionEvent = Event & {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
};

type RecognitionErrorEvent = Event & {
  readonly error: string;
  readonly message?: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function dictationErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission denied. Enable it in browser settings.";
    case "audio-capture":
      return "No microphone was found.";
    case "no-speech":
      return "No speech was detected. Try again.";
    case "network":
      return "Dictation could not connect. Check your network and try again.";
    default:
      return "Dictation stopped unexpectedly. Try again.";
  }
}

export function appendDictatedText(current: string, phrase: string): string {
  const spoken = phrase.trim();
  if (!spoken) return current;
  if (!current) return spoken;

  const needsSpace = !/\s$/.test(current) && !/^[,.;:!?)}\]]/.test(spoken);
  return `${current}${needsSpace ? " " : ""}${spoken}`;
}

export type DictationApi = {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => Promise<void>;
  cancel: () => void;
};

export type DictationChunk = {
  transcript: string;
  isFinal: boolean;
};

export function useDictation(
  onTranscript: (chunk: DictationChunk) => void,
  language?: string,
): DictationApi {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const transcriptHandlerRef = useRef(onTranscript);
  const mountedRef = useRef(false);
  const stopWaiterRef = useRef<{
    resolve: () => void;
    timeout: number;
  } | null>(null);

  transcriptHandlerRef.current = onTranscript;

  const settleStop = useCallback(() => {
    const waiter = stopWaiterRef.current;
    if (!waiter) return;
    stopWaiterRef.current = null;
    window.clearTimeout(waiter.timeout);
    waiter.resolve();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setSupported(Boolean(recognitionConstructor()));

    return () => {
      mountedRef.current = false;
      settleStop();
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (!recognition) return;
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    };
  }, [settleStop]);

  const start = useCallback(() => {
    if (recognitionRef.current) return;

    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setSupported(false);
      setError("Dictation is not supported in this browser.");
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language || window.navigator.language || "en-US";

    recognition.onstart = () => {
      if (!mountedRef.current || recognitionRef.current !== recognition) return;
      setError(null);
      setListening(true);
    };

    recognition.onresult = (event) => {
      if (!mountedRef.current || recognitionRef.current !== recognition) return;
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (transcript) {
          transcriptHandlerRef.current({
            transcript,
            isFinal: result.isFinal,
          });
        }
      }
    };

    recognition.onerror = (event) => {
      if (!mountedRef.current || recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      settleStop();
      if (event.error !== "aborted") {
        setError(dictationErrorMessage(event.error));
      }
      setListening(false);
    };

    recognition.onend = () => {
      if (!mountedRef.current || recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      settleStop();
      setListening(false);
    };

    setError(null);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError("Dictation could not start. Try again.");
    }
  }, [language, settleStop]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return Promise.resolve();
    setListening(false);
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }
        stopWaiterRef.current = null;
        resolve();
      }, 1000);
      stopWaiterRef.current = { resolve, timeout };
      try {
        recognition.stop();
      } catch {
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }
        settleStop();
      }
    });
  }, [settleStop]);

  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    setListening(false);
    settleStop();
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
    }
  }, [settleStop]);

  return { supported, listening, error, start, stop, cancel };
}
