import { useState } from "react";
import { Linking, StyleSheet, Text } from "react-native";
import {
  Card,
  CreatorScreen,
  Empty,
  ErrorNote,
  KeyValue,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../../components/creator/CreatorChrome";
import { useCreatorStorefront, useTogglePackage } from "../../features/creator/hooks";
import { money, type CreatorPackage } from "../../features/creator/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { friendlyError } from "../../components/ErrorCard";

const WEB = "https://www.zaviagent.com";

function templateLine(p: CreatorPackage): string {
  return [
    p.video_count ? `${p.video_count} video${p.video_count === 1 ? "" : "s"}` : null,
    p.video_length_seconds ? `${p.video_length_seconds} seconds` : null,
    p.ad_rights_days ? `${p.ad_rights_days} days of ad rights` : null,
    `${p.delivery_days} days to deliver`,
  ]
    .filter(Boolean)
    .join(", ");
}

function PackageCard({ pkg }: { pkg: CreatorPackage }) {
  const styles = useStyles(makeStyles);
  const toggle = useTogglePackage();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <Text style={styles.pkgTitle}>{pkg.title}</Text>
      <Text style={styles.hint}>{templateLine(pkg)}</Text>
      <KeyValue label="Your price" value={money(pkg.price_cents)} strong />
      <KeyValue label="Zavi fee" value={money(pkg.fees.creator_fee_cents)} />
      <KeyValue label="You receive" value={money(pkg.fees.creator_payout_cents)} strong />
      <KeyValue label="The business pays" value={money(pkg.fees.business_total_cents)} />
      <ErrorNote message={error} />
      <SecondaryButton
        label={
          toggle.isPending
            ? "Saving"
            : pkg.active
              ? "Take off my page"
              : "Put back on my page"
        }
        disabled={toggle.isPending}
        onPress={() => {
          setError(null);
          toggle.mutate(
            { packageId: pkg.id, active: !pkg.active },
            {
              onError: (e) =>
                setError(friendlyError(e, "That did not save. Try again.")),
            },
          );
        }}
      />
      {!pkg.active ? (
        <Text style={styles.hint}>Off your page. Nobody can book this one right now.</Text>
      ) : null}
    </Card>
  );
}

export default function CreatorStorefrontScreen() {
  const styles = useStyles(makeStyles);
  const { data, isPending, error } = useCreatorStorefront();
  const open = (path: string) => {
    void Linking.openURL(`${WEB}${path}`).catch(() => {});
  };

  return (
    <CreatorScreen title="Storefront">
      {error ? (
        <ErrorNote
          message={friendlyError(error, "Your page did not load.")}
        />
      ) : isPending || !data ? (
        <Loading what="your page" />
      ) : (
        <>
          <Card>
            <Text style={styles.h2}>Who sees this</Text>
            <Text style={styles.hint}>
              Businesses signed in to Zavi see your packages, your videos, your city and your social
              accounts when they look for creators. Never your email, your legal name or your date
              of birth.
            </Text>
          </Card>

          <SectionTitle>Packages and prices</SectionTitle>
          {data.packages.length === 0 ? (
            <Empty>No packages yet. Add them in your signup and they show up here.</Empty>
          ) : (
            data.packages.map((p) => <PackageCard key={p.id} pkg={p} />)
          )}

          <Card>
            <Text style={styles.h2}>Changing a price or a name</Text>
            <Text style={styles.hint}>
              Prices and names are edited on zaviagent.com. The shape of a package is the same for
              everyone so businesses can compare. The price is yours.
            </Text>
            <SecondaryButton
              label="Edit on zaviagent.com"
              onPress={() => open("/creator/storefront")}
            />
          </Card>
        </>
      )}
    </CreatorScreen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  h2: { fontSize: font.size.base, fontWeight: "700", color: colors.ink },
  pkgTitle: { fontSize: font.size.lg, fontWeight: "700", color: colors.ink },
  url: { fontSize: font.size.base, fontWeight: "700", color: colors.ink },
  hint: { fontSize: font.size.sm, lineHeight: 18, color: colors.muted, marginBottom: space.xs },
});
