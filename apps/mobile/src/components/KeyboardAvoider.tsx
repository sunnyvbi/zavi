import { useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardTop } from "./useKeyboardReveal";

export function KeyboardAvoider({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  if (Platform.OS === "ios") {
    return (
      <KeyboardAvoidingView style={style} behavior="padding">
        {children}
      </KeyboardAvoidingView>
    );
  }
  return <AndroidKeyboardAvoider style={style}>{children}</AndroidKeyboardAvoider>;
}

let lastTopInset = 0;
export function useSteadyTopInset(): number {
  const { top } = useSafeAreaInsets();
  if (top > 0) lastTopInset = top;
  return lastTopInset || top;
}

function AndroidKeyboardAvoider({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const box = useRef<View>(null);
  const keyboardTop = useKeyboardTop();
  const statusBar = useSteadyTopInset();
  const [boxBottom, setBoxBottom] = useState(0);

  const lift = keyboardTop === null ? 0 : Math.max(0, boxBottom + statusBar - keyboardTop);

  return (
    <View
      ref={box}
      style={[style, { paddingBottom: lift }]}
      onLayout={() => {
        box.current?.measureInWindow((_x, y, _w, h) => {
          setBoxBottom(y + h);
        });
      }}
    >
      {children}
    </View>
  );
}
