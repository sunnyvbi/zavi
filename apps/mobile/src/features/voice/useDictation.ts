import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorCode,
} from "expo-speech-recognition";

export type DictationPhase = "idle" | "permission" | "starting" | "listening" | "stopping" | "review";

type DictationState = {
  phase: DictationPhase;
  transcript: string;
  error: string | null;
  canOpenSettings: boolean;
  permissionDialog: "rationale" | "settings" | null;
};

type DictationOptions = {
  scopeKey: string;
  enabled: boolean;
  onConfirm: (text: string) => void;
};

type DictationSession = {
  scopeKey: string;
  accepting: boolean;
  nativeStarted: boolean;
  confirmOnEnd: boolean;
  finalText: string;
  interimText: string;
  listeners: { remove: () => void }[];
  timeout?: ReturnType<typeof setTimeout>;
  resolvePermission?: (accepted: boolean) => void;
};

function recognitionError(code: ExpoSpeechRecognitionErrorCode): string {
  switch (code) {
    case "no-speech":
    case "speech-timeout":
      return "I didn't hear any speech. Try again.";
    case "not-allowed":
      return "Allow microphone access to dictate a message.";
    case "service-not-allowed":
    case "language-not-supported":
      return "Speech recognition is unavailable on this device. You can still type your message.";
    case "network":
      return "Speech recognition couldn't connect. Check your connection and try again.";
    case "busy":
      return "The microphone is busy. Try again in a moment.";
    case "audio-capture":
    case "interrupted":
      return "The microphone was interrupted. Try again.";
    default:
      return "Voice input couldn't finish. Try again.";
  }
}

export function useDictation(options: DictationOptions) {
  const [state, setState] = useState<DictationState>({
    phase: "idle",
    transcript: "",
    error: null,
    canOpenSettings: false,
    permissionDialog: null,
  });
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  const mounted = useRef(true);
  const sessionRef = useRef<DictationSession | null>(null);

  const update = useCallback((patch: Partial<DictationState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    if (mounted.current) setState(stateRef.current);
  }, []);

  const clearSession = useCallback((session: DictationSession) => {
    clearTimeout(session.timeout);
    session.listeners.forEach((listener) => listener.remove());
    session.listeners = [];
    session.resolvePermission?.(false);
    session.resolvePermission = undefined;
    if (sessionRef.current === session) {
      sessionRef.current = null;
      update({ permissionDialog: null });
    }
  }, [update]);

  const acceptsResults = useCallback((session: DictationSession) => {
    return mounted.current && sessionRef.current === session && session.accepting &&
      optionsRef.current.enabled && optionsRef.current.scopeKey === session.scopeKey &&
      AppState.currentState === "active";
  }, []);

  const finish = useCallback((session: DictationSession) => {
    if (sessionRef.current !== session) return;
    const accepted = acceptsResults(session);
    const text = [session.finalText, session.interimText].filter(Boolean).join(" ").trim();
    clearSession(session);
    if (!accepted) {
      update({ phase: "idle", transcript: "" });
    } else if (!text) {
      update({
        phase: "idle",
        transcript: "",
        error: stateRef.current.error || "I didn't hear any speech. Try again.",
      });
    } else if (session.confirmOnEnd && !stateRef.current.error) {
      update({ phase: "idle", transcript: "" });
      optionsRef.current.onConfirm(text);
    } else {
      update({ phase: "review", transcript: text });
    }
  }, [acceptsResults, clearSession, update]);

  const abortSession = useCallback((session: DictationSession) => {
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => finish(session), 2000);
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      finish(session);
    }
  }, [finish]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    update({ transcript: "", error: null, canOpenSettings: false });
    if (!session) {
      update({ phase: "idle" });
      return;
    }
    session.accepting = false;
    session.confirmOnEnd = false;
    if (session.nativeStarted) {
      update({ phase: "stopping" });
      abortSession(session);
    } else {
      clearSession(session);
      update({ phase: "idle" });
    }
  }, [abortSession, clearSession, update]);

  useLayoutEffect(() => {
    const previous = optionsRef.current;
    optionsRef.current = options;
    if (previous.scopeKey !== options.scopeKey || (previous.enabled && !options.enabled)) {
      cancel();
    }
  }, [options, cancel]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") cancel();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      const session = sessionRef.current;
      if (!session) return;
      clearSession(session);
      if (session.nativeStarted) {
        try {
          ExpoSpeechRecognitionModule.abort();
        } catch {
          return;
        }
      }
    };
  }, [cancel, clearSession]);

  async function start() {
    if (!optionsRef.current.enabled || stateRef.current.phase !== "idle" || sessionRef.current) return;
    const session: DictationSession = {
      scopeKey: optionsRef.current.scopeKey,
      accepting: true,
      nativeStarted: false,
      confirmOnEnd: false,
      finalText: "",
      interimText: "",
      listeners: [],
    };
    sessionRef.current = session;
    update({ phase: "permission" });
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        clearSession(session);
        update({ phase: "idle", error: recognitionError("service-not-allowed") });
        return;
      }
      const nativeState = await ExpoSpeechRecognitionModule.getStateAsync();
      if (!acceptsResults(session)) {
        if (sessionRef.current === session) cancel();
        return;
      }
      if (nativeState !== "inactive") {
        clearSession(session);
        update({ phase: "idle", error: "Voice input is still stopping. Try again in a moment." });
        return;
      }
      let permission = await ExpoSpeechRecognitionModule.getPermissionsAsync();
      if (!acceptsResults(session)) {
        if (sessionRef.current === session) cancel();
        return;
      }
      const needsSettings = !permission.canAskAgain;
      const asksAgain =
        !permission.granted &&
        (needsSettings || (permission.status === "denied" && Platform.OS === "android"));
      if (asksAgain) {
        const accepted = await new Promise<boolean>((resolve) => {
          session.resolvePermission = resolve;
          update({ permissionDialog: needsSettings ? "settings" : "rationale" });
        });
        if (!acceptsResults(session)) {
          if (sessionRef.current === session) cancel();
          return;
        }
        if (needsSettings) {
          clearSession(session);
          update({
            phase: "idle",
            error: "Microphone access is turned off. Enable it in Settings to dictate, or keep typing.",
            canOpenSettings: true,
          });
          if (accepted) {
            try {
              await Linking.openSettings();
            } catch {
              if (mounted.current && optionsRef.current.scopeKey === session.scopeKey) {
                update({ error: "Open your device Settings, then Apps, Zavi, Permissions, and allow Microphone." });
              }
            }
          }
          return;
        }
        if (!accepted) {
          clearSession(session);
          update({ phase: "idle" });
          return;
        }
      }
      if (!permission.granted) {
        permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      }
      if (!acceptsResults(session)) {
        if (sessionRef.current === session) cancel();
        return;
      }
      if (!permission.granted) {
        clearSession(session);
        update({
          phase: "idle",
          error: permission.canAskAgain
            ? "Allow microphone access to dictate a message."
            : "Microphone access is turned off. Enable it in Settings.",
          canOpenSettings: !permission.canAskAgain,
        });
        return;
      }
      update({ phase: "starting", transcript: "", error: null, canOpenSettings: false });
      session.listeners = [
        ExpoSpeechRecognitionModule.addListener("start", () => {
          if (acceptsResults(session) && stateRef.current.phase === "starting") {
            update({ phase: "listening" });
          }
        }),
        ExpoSpeechRecognitionModule.addListener("result", (event) => {
          if (!acceptsResults(session)) return;
          const text = event.results[0]?.transcript.trim();
          if (!text) return;
          if (event.isFinal) {
            session.finalText = Platform.OS === "android"
              ? [session.finalText, text].filter(Boolean).join(" ")
              : text;
            session.interimText = "";
          } else {
            session.interimText = text;
          }
          update({ transcript: [session.finalText, session.interimText].filter(Boolean).join(" ") });
        }),
        ExpoSpeechRecognitionModule.addListener("error", (event) => {
          if (!acceptsResults(session) || event.error === "aborted") return;
          session.confirmOnEnd = false;
          update({ error: recognitionError(event.error) });
        }),
        ExpoSpeechRecognitionModule.addListener("end", () => finish(session)),
      ];
      session.nativeStarted = true;
      ExpoSpeechRecognitionModule.start({
        lang: Intl.DateTimeFormat().resolvedOptions().locale,
        interimResults: true,
        continuous: true,
        maxAlternatives: 1,
      });
    } catch {
      if (sessionRef.current !== session) return;
      update({ error: "Voice input couldn't start. Try again." });
      if (session.nativeStarted) {
        session.confirmOnEnd = false;
        update({ phase: "stopping" });
        abortSession(session);
      } else {
        clearSession(session);
        update({ phase: "idle" });
      }
    }
  }

  function confirm() {
    if (!optionsRef.current.enabled || AppState.currentState !== "active") return;
    if (stateRef.current.phase === "review") {
      const text = stateRef.current.transcript.trim();
      update({ phase: "idle", transcript: "", error: null });
      if (text) optionsRef.current.onConfirm(text);
      return;
    }
    const session = sessionRef.current;
    if (!session || !session.nativeStarted || !acceptsResults(session) ||
      stateRef.current.phase === "stopping") return;
    session.confirmOnEnd = true;
    update({ phase: "stopping" });
    session.timeout = setTimeout(() => {
      if (sessionRef.current !== session) return;
      session.confirmOnEnd = false;
      update({ error: "Voice input took too long to finish. Review any captured words or try again." });
      abortSession(session);
    }, 8000);
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      session.confirmOnEnd = false;
      update({ error: "Voice input couldn't finish. Review any captured words or try again." });
      abortSession(session);
    }
  }

  function respondToPermission(accepted: boolean) {
    const session = sessionRef.current;
    if (!session?.resolvePermission) return;
    const resolve = session.resolvePermission;
    session.resolvePermission = undefined;
    update({ permissionDialog: null });
    resolve(accepted);
  }

  return { ...state, start, confirm, cancel, respondToPermission };
}
