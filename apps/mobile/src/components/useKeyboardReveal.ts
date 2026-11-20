import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  Keyboard,
  Platform,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const REVEAL_MARGIN = 16;

export type Revealable = { measureInWindow: View["measureInWindow"] };

export function useKeyboardOpen() {
  const [keyboardOpen, setKeyboardOpen] = useState(() => Keyboard.isVisible());

  useEffect(() => {
    const ios = Platform.OS === "ios";
    setKeyboardOpen(Keyboard.isVisible());
    const subs = [
      Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardOpen(true)),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardOpen(false)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  return keyboardOpen;
}

export function useKeyboardTop() {
  const { bottom: gestureBar } = useSafeAreaInsets();
  const [height, setHeight] = useState(() => Keyboard.metrics()?.height ?? null);

  useEffect(() => {
    setHeight(Keyboard.metrics()?.height ?? null);
    const subs = [
      Keyboard.addListener("keyboardDidShow", (e) => setHeight(e.endCoordinates.height)),
      Keyboard.addListener("keyboardDidHide", () => setHeight(null)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  return height === null ? null : Dimensions.get("screen").height - height - gestureBar;
}

export function useKeyboardReveal() {
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const focused = useRef<Revealable | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOpen = useKeyboardOpen();

  const scrollToFocused = useCallback(() => {
    const target = focused.current;
    const scroll = scrollRef.current;
    const host = scroll?.getNativeScrollRef();
    if (!target || !scroll || !host) return;
    host.measureInWindow((_sx, sy, _sw, sh) => {
      target.measureInWindow((_x, y, _w, h) => {
        const top = sy + REVEAL_MARGIN;
        const bottom = sy + sh - REVEAL_MARGIN;
        let delta = 0;
        if (y + h > bottom) delta = Math.min(y + h - bottom, y - top);
        else if (y < top) delta = y - top;
        if (delta === 0) return;
        scroll.scrollTo({ y: Math.max(0, scrollY.current + delta), animated: true });
      });
    });
  }, []);

  const scrollSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(scrollToFocused, 60);
  }, [scrollToFocused]);

  const reveal = useCallback(
    (target: Revealable | null) => {
      focused.current = target;
      scrollSoon();
    },
    [scrollSoon],
  );

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
  }, []);

  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", scrollSoon);
    return () => {
      sub.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [scrollSoon]);

  return { keyboardOpen, scrollRef, onScroll, reveal };
}
