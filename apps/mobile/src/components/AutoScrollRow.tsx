import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, ScrollView, View } from "react-native";
import { useIsFocused } from "expo-router";
import { useReduceMotion } from "../lib/motion";

const SPEED = 22;
const RESUME_MS = 2500;
const HOLD_MAX_MS = 8000;
const ROOM = 8000;

export function AutoScrollRow({ children, gap, inset }: { children: ReactNode; gap: number; inset: number }) {
  const reduceMotion = useReduceMotion();
  const focused = useIsFocused();
  const drift = useRef(new Animated.Value(0)).current;
  const width = useRef(0);
  const resume = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedAt = useRef(0);
  const [copies, setCopies] = useState(1);
  const home = (copies - 1) / 2;

  const moving = !reduceMotion && focused && copies > 1;

  const run = () => {
    const w = width.current;
    if (w <= 0) return;
    const at = -((((-stoppedAt.current) % w) + w) % w);
    drift.setValue(at);
    const loop = Animated.loop(
      Animated.timing(drift, { toValue: -w, duration: (w / SPEED) * 1000, easing: Easing.linear, useNativeDriver: true }),
    );
    Animated.timing(drift, {
      toValue: -w,
      duration: ((w + at) / SPEED) * 1000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      drift.setValue(0);
      loop.start();
    });
  };
  const pause = (forMs: number) => {
    drift.stopAnimation((v) => {
      stoppedAt.current = v;
    });
    if (resume.current) clearTimeout(resume.current);
    resume.current = setTimeout(run, forMs);
  };

  useEffect(() => {
    if (!moving) return;
    run();
    return () => {
      drift.stopAnimation();
      if (resume.current) clearTimeout(resume.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving]);

  const user = moving ? () => pause(RESUME_MS) : undefined;
  const row = { flexDirection: "row" as const, gap, paddingRight: gap };
  const shown = reduceMotion ? 1 : copies;
  return (
    <ScrollView
      key={shown}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentOffset={{ x: reduceMotion ? 0 : home * width.current, y: 0 }}
      contentContainerStyle={{ paddingLeft: inset, paddingRight: reduceMotion ? inset - gap : 0 }}
      scrollEventThrottle={64}
      onScroll={user}
      onTouchStart={moving ? () => pause(HOLD_MAX_MS) : undefined}
      onTouchEnd={user}
      onTouchCancel={user}
    >
      <Animated.View style={{ flexDirection: "row", transform: [{ translateX: reduceMotion ? 0 : drift }] }}>
        {Array.from({ length: shown }, (_, i) => (
          <View
            key={i}
            style={row}
            importantForAccessibility={i === home || reduceMotion ? "auto" : "no-hide-descendants"}
            accessibilityElementsHidden={i !== home && !reduceMotion}
            onLayout={
              i === 0 && copies === 1 && !reduceMotion
                ? (e) => {
                    const w = e.nativeEvent.layout.width;
                    if (w <= 0) return;
                    width.current = w;
                    setCopies((Math.ceil(ROOM / w) + 1) * 2 + 1);
                  }
                : undefined
            }
          >
            {children}
          </View>
        ))}
      </Animated.View>
    </ScrollView>
  );
}
