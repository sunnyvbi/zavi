import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  useBottomSheetModal,
  type BottomSheetScrollViewMethods,
} from "@gorhom/bottom-sheet";

export function useBackClosesSheet() {
  const { dismiss } = useBottomSheetModal();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      dismiss();
      return true;
    });
    return () => sub.remove();
  }, [open, dismiss]);
  return useCallback((index: number) => setOpen(index >= 0), []);
}
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotion } from "../lib/motion";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { Icon } from "./Icon";

export function AppBottomSheet({
  open,
  onClose,
  title,
  locked = false,
  scrollRef,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  locked?: boolean;
  scrollRef?: Ref<BottomSheetScrollViewMethods>;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const presented = useRef(false);

  useEffect(() => {
    if (open) {
      presented.current = true;
      sheetRef.current?.present();
    } else if (presented.current) {
      sheetRef.current?.dismiss();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!locked) sheetRef.current?.dismiss();
      return true;
    });
    return () => sub.remove();
  }, [open, locked]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior={locked ? "none" : "close"} />
    ),
    [locked],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      topInset={insets.top}
      maxDynamicContentSize={Math.round(windowHeight * 0.86)}
      enablePanDownToClose={!locked}
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleIndicatorStyle={styles.handle}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onDismiss={() => {
        presented.current = false;
        onClose();
      }}
    >
      <BottomSheetScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: footer ? space.sm : Math.max(20, insets.bottom + space.lg) }]}
      >
        {title ? (
          <View style={styles.titleRow}>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            <Pressable
              onPress={() => sheetRef.current?.dismiss()}
              disabled={locked}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: locked }}
              style={({ pressed }) => [styles.close, (pressed || locked) && styles.closeFaded]}
            >
              <Icon name="close" size={16} color={colors.ink} strokeWidth={2} />
            </Pressable>
          </View>
        ) : null}
        {children}
      </BottomSheetScrollView>
      {footer ? (
        <View style={[styles.footerWrap, { paddingBottom: Math.max(20, insets.bottom + space.lg) }]}>
          <View style={styles.footerDivider} />
          <View style={styles.footerContent}>{footer}</View>
        </View>
      ) : null}
    </BottomSheetModal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    background: { backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
    handle: { width: 30, height: 4, backgroundColor: colors.muted, opacity: 0.4 },
    content: { paddingHorizontal: space.lg, paddingTop: space.xs },
    titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, marginBottom: space.md },
    title: { flex: 1, minWidth: 0, fontFamily: font.family.semi, fontSize: 20, lineHeight: 26, includeFontPadding: false, color: colors.ink },
    close: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" },
    closeFaded: { opacity: 0.5 },
    footerWrap: { backgroundColor: colors.surfaceRaised },
    footerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
    footerContent: { paddingHorizontal: space.lg, paddingTop: space.md },
  });
