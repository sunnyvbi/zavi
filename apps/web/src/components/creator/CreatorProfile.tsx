"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Lock, Pencil, Plus, Star, Upload, Video } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { creatorApi, CreatorApiError, type CreatorPackage, type CreatorProfile, type CreatorReviews } from "@/lib/creator/api";
import { shortDate } from "./CreatorInbox";
import { PHOTO_ACCEPT, uploadProfilePhoto } from "@/lib/creator/photo";
import { fetchIntroVideoUrl } from "@/lib/creator/introVideo";
import {
  LANE_PLATFORMS,
  PLATFORM_KEY,
  SELF_REPORTED,
  SOCIAL_PLACEHOLDER,
  countryName,
  creatorGets,
  defaultPackage,
  money,
  nicheLabel,
  packageTerms,
  packageTitle,
  platformFromKey,
  priceCents,
  socialError,
  specFromSaved,
  toPackagePayload,
  type LanePlatform,
  type PackageSpec,
} from "@/lib/creator/packageSpec";
import { parseSocial } from "@zavi/shared";
import { useCreatorMe } from "./CreatorChrome";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_SMALL,
  Bone,
  Card,
  ErrorNote,
  FIELD,
  FeeLine,
  H1,
  PackageBuilder,
  PlatformIcon,
  RING,
  SectionLabel,
  SocialLink,
} from "./areaUi";

const COMPACT = "!h-10 !px-5 !text-[14px]";
const BTN_MAIN = `${BTN_PRIMARY} ${COMPACT}`;
const BTN_SIDE = `${BTN_SECONDARY} ${COMPACT}`;
const BTN_DANGER = `${BTN_SMALL} !text-danger hover:!bg-danger/5`;

function errText(e: unknown, fallback: string): string {
  return e instanceof CreatorApiError ? e.message : fallback;
}

export function CreatorProfileScreen() {
  const { me, reload } = useCreatorMe();
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [pkgs, setPkgs] = useState<CreatorPackage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    creatorApi.profile().then(setProfile).catch((e) => setError(errText(e, "Your profile did not load.")));
    creatorApi
      .storefront()
      .then((v) => setPkgs(v.packages))
      .catch((e) => setError(errText(e, "Your packages did not load.")));
  }, []);
  useEffect(load, [load]);

  const refresh = () => {
    load();
    reload();
  };

  return (
    <div>
      <H1 title="Profile" blurb="What businesses see when they find you in Zavi. Changes show straight away." />
      {error ? (
        <div className="mt-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {!profile || !pkgs ? (
        error ? null : <ProfileSkeleton />
      ) : (
        <div className="mt-6 grid items-start gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <NameCard name={me.creator.display_name} onChanged={refresh} />
            <ProfilePhotoCard
              name={me.creator.display_name}
              photoUrl={profile.photo_url ?? null}
              illustrationUrl={profile.illustration_url ?? null}
              onChanged={refresh}
            />
            <IntroVideoCard name={profile.intro_video_name} onChanged={refresh} />
          </div>

          <div className="min-w-0 space-y-4">
            <BioCard bio={profile.bio} onSaved={refresh} />
            <AccountsCard accounts={profile.accounts} onSaved={refresh} />
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel>What you make</SectionLabel>
                <Link href="/creators/apply?step=make" className={BTN_SMALL}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </Link>
              </div>
              <p className="mt-3 text-[14px] text-muted">Niches: {profile.niches.length ? profile.niches.map(nicheLabel).join(", ") : "None yet"}</p>
              <p className="mt-1 text-[14px] text-muted">
                Country:{" "}
                {me.creator.country_code ? (
                  <span className="font-semibold text-foreground">{countryName(me.creator.country_code)}</span>
                ) : (
                  "Not added yet. Add it in the banner above."
                )}
              </p>
            </Card>
            <PackagesCard pkgs={pkgs} onChanged={refresh} />
            <ReviewsCard />
          </div>
        </div>
      )}
    </div>
  );
}

const score = (n: number | null) => (n == null ? null : n.toFixed(1));

function ReviewsCard() {
  const [data, setData] = useState<CreatorReviews | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    creatorApi.reviews().then(setData).catch((e) => setError(errText(e, "Your reviews did not load.")));
  }, []);
  const a = data?.aggregates;
  const rated = !!a && a.review_count > 0;
  const dims: Array<[string, number | null | undefined]> = [
    ["Communication", a?.avg_communication],
    ["On time", a?.avg_timeliness],
    ["Happy with the result", a?.avg_satisfaction],
  ];
  return (
    <Card>
      <SectionLabel>Your reviews</SectionLabel>
      {error ? (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      ) : !data ? (
        <Bone className="mt-3 h-8 w-40" />
      ) : (
        <>
          <p data-testid="review-overall" className="mt-2 inline-flex items-center gap-2 text-[22px] font-bold text-foreground">
            <Star className={`h-5 w-5 ${rated ? "fill-current" : ""}`} aria-hidden="true" />
            {rated ? (
              <>
                {score(a.avg_overall)}
                <span className="text-[14px] font-medium text-muted">
                  from {a.review_count} {a.review_count === 1 ? "review" : "reviews"}
                </span>
              </>
            ) : (
              <span className="text-[14px] font-medium text-muted">No reviews yet</span>
            )}
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-[14px] sm:grid-cols-3">
            {dims.map(([l, v]) => (
              <div key={l} className="flex justify-between gap-3 sm:flex-col sm:gap-0.5">
                <dt className="text-muted">{l}</dt>
                <dd className={`font-semibold ${v == null ? "text-muted" : "text-foreground"}`}>{v == null ? "Not rated yet" : `${score(v)} / 5`}</dd>
              </div>
            ))}
          </dl>
          {rated && (
            <ul className="mt-4 divide-y divide-black/[0.06] border-t border-black/[0.06]">
              {data.reviews.map((r) => {
                const overall = (r.communication + r.timeliness + r.satisfaction) / 3;
                return (
                  <li key={r.id} data-testid="review" className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[14px] font-semibold text-foreground">{r.business_name}</p>
                      <p className="inline-flex items-center gap-1 text-[13px] text-muted">
                        <Star className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                        {overall.toFixed(1)} · {shortDate(r.created_at)}
                      </p>
                    </div>
                    {r.body && <p className="mt-1 text-[14px] leading-relaxed text-foreground">{r.body}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function ProfileSkeleton() {
  const card = "rounded-block border border-black/[0.06] bg-white p-6";
  return (
    <div role="status" aria-live="polite" className="mt-6">
      <span className="sr-only">Loading your profile.</span>
      <div aria-hidden="true" className="grid items-start gap-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className={card}>
            <Bone className="h-3 w-24 rounded-full" />
            <Bone className="mt-4 h-11 w-full rounded-xl" />
            <Bone className="mt-3 h-3 w-full rounded-full" />
            <Bone className="mt-2 h-3 w-2/3 rounded-full" />
            <Bone className="mt-6 h-4 w-40 rounded-full" />
          </div>
          <div className={card}>
            <Bone className="h-3 w-32 rounded-full" />
            <Bone className="mx-auto mt-4 size-40 rounded-xl" />
            <Bone className="mt-4 h-12 w-full rounded-full" />
          </div>
        </div>
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className={card}>
              <div className="flex items-center justify-between gap-3">
                <Bone className="h-3 w-28 rounded-full" />
                <Bone className="h-9 w-24 rounded-full" />
              </div>
              <Bone className="mt-4 h-4 w-3/4 rounded-full" />
              <Bone className="mt-2 h-4 w-1/2 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function NameCard({ name, onChanged }: { name: string; onChanged: () => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => setValue(name), [name]);
  useEffect(() => {
    void createBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null))
      .catch(() => setEmail(null));
  }, []);

  const trimmed = value.trim();
  const changed = trimmed !== name.trim();

  async function save() {
    if (!trimmed || !changed) return;
    setBusy(true);
    setError(null);
    try {
      await creatorApi.saveProfile({ display_name: trimmed });
      toast.add({ type: "success", title: "Name saved", timeout: 4000, dismissible: false });
      onChanged();
    } catch (e) {
      setError(errText(e, "Your name did not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionLabel>Your name</SectionLabel>
      <label className="mt-2 block">
        <span className="sr-only">Your name</span>
        <input
          value={value}
          maxLength={120}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          className={`${FIELD} h-11 px-3`}
        />
      </label>
      <p className="mt-1.5 text-[13px] text-muted">Businesses see this on your card and your jobs. Your profile link stays the same.</p>
      {error ? (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <div className={changed ? "mt-3 flex items-center gap-3" : "hidden"}>
        {changed ? (
          <button type="button" disabled={busy || !trimmed} onClick={() => void save()} className={BTN_MAIN}>
            {busy ? "Saving…" : "Save name"}
          </button>
        ) : null}
      </div>
      <EmailChange email={email} />
    </Card>
  );
}

function EmailChange({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const trimmed = next.trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.toLowerCase() !== (email ?? "").toLowerCase();

  async function send() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const { error: e } = await createBrowserSupabase().auth.updateUser(
      { email: trimmed },
      { emailRedirectTo: `${window.location.origin}/creator/profile` },
    );
    setBusy(false);
    if (e) {
      setError(e.message || "That email could not be used. Try another.");
      return;
    }
    setSentTo(trimmed);
    setOpen(false);
    setNext("");
  }

  return (
    <div className="mt-4 border-t border-black/[0.06] pt-3">
      <p className="text-[13px] font-semibold text-foreground">Email</p>
      <p className="mt-0.5 break-all text-[14px] text-foreground">{email ?? "Loading…"}</p>
      <p className="mt-1 text-[13px] text-muted">You sign in with this email, and Zavi sends your job emails here.</p>
      {sentTo ? (
        <p className="mt-2 rounded-lg bg-black/[0.03] px-3 py-2 text-[13px] leading-snug text-foreground">
          Check {sentTo} for a link to confirm the change. Your email stays {email ?? "the same"} until you click it.
        </p>
      ) : null}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className={`${BTN_SMALL} mt-3`}>
          Change email
        </button>
      ) : (
        <div className="mt-3 grid gap-2">
          <label className="block">
            <span className="text-[14px] font-medium text-foreground">New email</span>
            <input
              type="email"
              autoComplete="email"
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setError(null);
              }}
              className={`${FIELD} mt-1 h-11 px-3`}
            />
          </label>
          {error ? <ErrorNote message={error} /> : null}
          <div className="flex gap-2">
            <button type="button" disabled={busy || !valid} onClick={() => void send()} className={BTN_SMALL}>
              {busy ? "Sending…" : "Send confirmation link"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-[13px] font-medium text-muted hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfilePhotoCard({
  name,
  photoUrl,
  illustrationUrl,
  onChanged,
}: {
  name: string;
  photoUrl: string | null;
  illustrationUrl: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      await uploadProfilePhoto(file);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload did not finish. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await creatorApi.saveProfile({ photo_path: null });
      onChanged();
    } catch (e) {
      setError(errText(e, "That did not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const picker = (label: string, primary: boolean) => (
    <label className={`${primary ? BTN_MAIN : BTN_SIDE} mt-4 w-full ${busy ? "pointer-events-none opacity-40" : ""}`}>
      <Upload className="h-4 w-4" aria-hidden="true" />
      {busy ? "Uploading…" : label}
      <input
        type="file"
        accept={PHOTO_ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
    </label>
  );

  const shown = photoUrl ?? illustrationUrl;
  return (
    <Card>
      <SectionLabel>Profile photo (optional)</SectionLabel>
      <div className="relative mx-auto mt-3 flex aspect-square w-full max-w-[160px] items-center justify-center overflow-hidden rounded-xl bg-black/[0.04]">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt={photoUrl ? "Your profile photo" : "Your illustration"} className="h-full w-full object-cover" />
        ) : (
          <span className="text-[36px] font-bold text-muted">{initialsOf(name)}</span>
        )}
        {!photoUrl && illustrationUrl ? (
          <span className="absolute inset-x-2 bottom-2 rounded-md bg-white/90 py-0.5 text-center text-[11px] font-semibold text-muted">
            Illustration
          </span>
        ) : null}
      </div>
      {photoUrl ? (
        <>
          {picker("Replace photo", false)}
          <button type="button" disabled={busy} onClick={remove} className={`${BTN_DANGER} mt-2 !h-10 w-full`}>
            Remove photo
          </button>
        </>
      ) : (
        <>
          {picker("Upload photo", true)}
          <p className="mt-2 text-[13px] text-muted">
            {illustrationUrl
              ? "Businesses see this illustration until you add a photo. JPG, PNG or WebP, up to 5 MB."
              : "Shown on your card in Find creators. JPG, PNG or WebP, up to 5 MB."}
          </p>
        </>
      )}
      {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{error}</p> : null}
    </Card>
  );
}

function IntroPlayer({ version }: { version: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    setFailed(null);
    fetchIntroVideoUrl("/api/creator/intro-video")
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch((e: unknown) => {
        if (live) setFailed(e instanceof Error ? e.message : "The video did not load. Try again.");
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [version]);
  const box = "mx-auto mt-3 aspect-[9/16] w-full max-w-[160px] overflow-hidden rounded-xl";
  if (failed) {
    return (
      <div className={`${box} flex items-center justify-center bg-foreground/90 px-3 text-center text-[12px] text-white`}>
        <span>
          <Video className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          {failed}
        </span>
      </div>
    );
  }
  if (!url) {
    return (
      <div role="status" aria-live="polite" className={`${box} animate-pulse bg-[#e7e9ee] motion-reduce:animate-none`}>
        <span className="sr-only">Loading your intro video.</span>
      </div>
    );
  }
  return <video src={url} controls playsInline preload="metadata" aria-label="Your intro video" className={`${box} block bg-black object-contain`} />;
}

function IntroVideoCard({ name, onChanged }: { name: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const ticket = await creatorApi.introUploadUrl(file.type);
      const { error: upErr } = await createBrowserSupabase().storage.from("creator-media").uploadToSignedUrl(ticket.path, ticket.token, file);
      if (upErr) throw new Error("The upload did not finish. Try again.");
      await creatorApi.saveProfile({ intro_video_path: ticket.path });
      setVersion((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload did not finish. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await creatorApi.saveProfile({ intro_video_path: null });
      onChanged();
    } catch (e) {
      setError(errText(e, "That did not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const picker = (label: string, primary: boolean) => (
    <label className={`${primary ? BTN_MAIN : BTN_SIDE} mt-4 w-full ${busy ? "pointer-events-none opacity-40" : ""}`}>
      <Upload className="h-4 w-4" aria-hidden="true" />
      {busy ? "Uploading…" : label}
      <input
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <Card>
      <SectionLabel>Intro video (optional)</SectionLabel>
      {name ? (
        <>
          <IntroPlayer version={version} />
          <p className="mt-2 truncate text-[13px] text-muted">{name}</p>
          {picker("Replace video", false)}
          <button type="button" disabled={busy} onClick={remove} className={`${BTN_DANGER} mt-2 !h-10 w-full`}>
            Remove video
          </button>
        </>
      ) : (
        <>
          <div className="mx-auto mt-3 flex aspect-[9/16] w-full max-w-[160px] items-center justify-center rounded-xl border-2 border-dashed border-black/15 text-muted">
            <Video className="h-7 w-7" aria-hidden="true" />
          </div>
          {picker("Add intro video", true)}
          <p className="mt-2 text-[13px] text-muted">Up to 30 seconds. Shown on your card in Find creators.</p>
        </>
      )}
      {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{error}</p> : null}
    </Card>
  );
}

function BioCard({ bio, onSaved }: { bio: string | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bio ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await creatorApi.saveProfile({ bio: draft.trim() || null });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(errText(e, "That did not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Bio</SectionLabel>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(bio ?? "");
              setEditing(true);
            }}
            className={BTN_SMALL}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit bio
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea rows={3} aria-label="Bio" value={draft} onChange={(e) => setDraft(e.target.value)} className={`${FIELD} mt-3 resize-none px-4 py-3 leading-relaxed`} />
          {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{error}</p> : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={save} className={BTN_MAIN}>
              {busy ? "Saving…" : "Save bio"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={BTN_SIDE}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p className={`mt-3 text-[14px] leading-relaxed ${bio ? "text-foreground" : "text-muted"}`}>
          {bio || "No bio yet. Say what you make and who you make it for."}
        </p>
      )}
    </Card>
  );
}

type Account = { platform: LanePlatform; handle: string; url: string; followers: number | null };
type AccountDraft = { platform: LanePlatform; link: string; followers: string };

function normalize(platform: LanePlatform, link: string): { handle: string; url: string } | null {
  const r = parseSocial(PLATFORM_KEY[platform], link);
  return r.ok ? { handle: r.value.handle, url: r.value.url } : null;
}

function AccountsCard({ accounts: initial, onSaved }: { accounts: CreatorProfile["accounts"]; onSaved: () => void }) {
  const saved: Account[] = initial
    .map((a) => ({ platform: platformFromKey(a.platform), handle: a.handle, url: a.url ?? "", followers: a.followers }))
    .filter((a): a is Account => a.platform !== null);
  const [pending, setPending] = useState<Account[] | null>(null);
  const accounts = pending ?? saved;
  const [editing, setEditing] = useState<LanePlatform | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const free = LANE_PLATFORMS.filter((p) => !accounts.some((a) => a.platform === p));

  async function persist(next: Account[]) {
    setError(null);
    const missing = next.find((a) => !(typeof a.followers === "number" && a.followers > 0));
    if (missing) {
      setPending(next);
      setError(`Add the follower count for your ${missing.platform} account first.`);
      setAdding(false);
      setEditing(missing.platform);
      return;
    }
    try {
      await creatorApi.setupMake(next.map((a) => ({ platform: PLATFORM_KEY[a.platform], handle: a.handle, followers: a.followers as number })));
      setPending(null);
      setEditing(null);
      setAdding(false);
      onSaved();
    } catch (e) {
      setError(errText(e, "That did not save. Try again."));
    }
  }

  function save(d: AccountDraft, replacing: LanePlatform | null) {
    const found = normalize(d.platform, d.link);
    if (!found) return;
    const nextAcc: Account = { platform: d.platform, handle: found.handle, url: found.url, followers: Number(d.followers.replace(/[^0-9]/g, "")) };
    void persist(replacing ? accounts.map((a) => (a.platform === replacing ? nextAcc : a)) : [...accounts, nextAcc]);
  }

  return (
    <Card>
      <SectionLabel>Your accounts</SectionLabel>
      <p className="mt-1 text-[13px] text-muted">Businesses see these links and numbers on your card in Find creators.</p>
      {accounts.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-black/15 px-4 py-3 text-[14px] text-muted">No accounts yet. Add one so businesses can see your work.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {accounts.map((a) =>
            editing === a.platform ? (
              <li key={a.platform} className="rounded-xl border border-black/[0.08] bg-black/[0.02] p-4">
                <AccountForm
                  initial={{ platform: a.platform, link: a.handle, followers: a.followers ? a.followers.toLocaleString("en-US") : "" }}
                  platforms={[a.platform]}
                  onSave={(d) => save(d, a.platform)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={a.platform} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] text-foreground">
                    <PlatformIcon platform={a.platform} />
                    <span className="font-semibold">{a.platform}</span>
                  </p>
                  <SocialLink platform={a.platform} handle={a.handle} url={a.url} className="mt-1" />
                  <p className="mt-0.5 text-[14px] text-foreground">
                    {a.followers != null ? `${a.followers.toLocaleString("en-US")} followers` : "Followers not added"}{" "}
                    <span className="text-[12px] text-muted">({SELF_REPORTED})</span>
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setEditing(a.platform);
                    }}
                    className={BTN_SMALL}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </button>
                  <button type="button" onClick={() => void persist(accounts.filter((x) => x.platform !== a.platform))} className={BTN_DANGER}>
                    Remove
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{error}</p> : null}
      {adding && free.length > 0 ? (
        <div className="mt-3 rounded-xl border border-black/[0.08] bg-black/[0.02] p-4">
          <p className="mb-3 text-[14px] font-semibold text-foreground">New account</p>
          <AccountForm initial={{ platform: free[0], link: "", followers: "" }} platforms={free} onSave={(d) => save(d, null)} onCancel={() => setAdding(false)} />
        </div>
      ) : free.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
          className={`${BTN_SIDE} mt-3`}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add an account
        </button>
      ) : (
        <p className="mt-3 text-[13px] text-muted">You have added an account on every platform Zavi lists.</p>
      )}
    </Card>
  );
}

function AccountForm({
  initial,
  platforms,
  onSave,
  onCancel,
}: {
  initial: AccountDraft;
  platforms: LanePlatform[];
  onSave: (d: AccountDraft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<AccountDraft>(initial);
  const [blurred, setBlurred] = useState(false);
  const found = normalize(d.platform, d.link);
  const followersOk = Number(d.followers.replace(/[^0-9]/g, "")) > 0;
  const showError = d.link.trim() !== "" && !found && blurred;
  return (
    <div>
      {platforms.length > 1 ? (
        <div className="mb-3">
          <span className="mb-1.5 block text-[13px] font-medium text-muted">Platform</span>
          <div className="flex flex-wrap gap-2">
            {platforms.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={d.platform === p}
                onClick={() => setD({ ...d, platform: p })}
                className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-[14px] font-medium ${RING} ${
                  d.platform === p ? "border-foreground bg-foreground/[0.06] text-foreground" : "border-black/[0.1] bg-white text-foreground"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-foreground">
          <PlatformIcon platform={d.platform} />
          {d.platform}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_160px] sm:items-start">
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-medium text-muted">Profile link or handle</span>
          <input
            value={d.link}
            onChange={(e) => setD({ ...d, link: e.target.value })}
            onBlur={() => setBlurred(true)}
            placeholder={SOCIAL_PLACEHOLDER[d.platform]}
            aria-invalid={showError}
            className={`${FIELD} h-11 px-4`}
          />
          {found ? (
            <SocialLink platform={d.platform} handle={found.handle} url={found.url} className="mt-1.5" />
          ) : showError ? (
            <p role="alert" className="mt-2 text-[13px] font-medium text-danger">
              {socialError(d.platform)}
            </p>
          ) : null}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-medium text-muted">Followers</span>
          <input
            inputMode="numeric"
            value={d.followers}
            onChange={(e) => setD({ ...d, followers: e.target.value.replace(/[^0-9,]/g, "") })}
            placeholder="48,000"
            className={`${FIELD} h-11 px-4`}
          />
        </label>
      </div>
      <p className="mt-2 text-[12px] text-muted">{SELF_REPORTED}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={!found || !followersOk} onClick={() => onSave(d)} className={BTN_MAIN}>
          Save account
        </button>
        <button type="button" onClick={onCancel} className={BTN_SIDE}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PackagesCard({ pkgs, onChanged }: { pkgs: CreatorPackage[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: "", description: "", price: "" });
  const [adding, setAdding] = useState<PackageSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError(errText(e, "That did not save. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const cents = priceCents(edit.price);
    if (!cents) return;
    const ok = await run(() => creatorApi.savePackage(id, { title: edit.title.trim() || undefined, description: edit.description.trim() || null, price_cents: cents }));
    if (ok) setEditing(null);
  }

  return (
    <Card>
      <SectionLabel>Packages</SectionLabel>
      <p className="mt-2 flex gap-2 text-[13px] text-muted">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Package terms can&apos;t change once saved: you can edit the title, description and price, and turn a package on or off. To sell something
        different, add a new package.
      </p>
      <ul className="mt-3 space-y-3">
        {pkgs.map((row) => {
          const p = specFromSaved(row);
          const price = row.price_cents / 100;
          return (
            <li key={row.id} className={`rounded-xl border border-black/[0.08] bg-white px-4 py-3 ${row.active ? "" : "opacity-60"}`}>
              {editing === row.id ? (
                <div>
                  <label className="block">
                    <span className="mb-1.5 block text-[14px] font-medium text-muted">Title</span>
                    <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} className={`${FIELD} h-11 px-4`} />
                  </label>
                  <label className="mt-3 block">
                    <span className="mb-1.5 block text-[14px] font-medium text-muted">Description</span>
                    <input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} className={`${FIELD} h-11 px-4`} />
                  </label>
                  <label className="mt-3 block max-w-[200px]">
                    <span className="mb-1.5 block text-[14px] font-medium text-muted">Price</span>
                    <input
                      inputMode="decimal"
                      value={edit.price}
                      onChange={(e) => setEdit({ ...edit, price: e.target.value.replace(/[^0-9.]/g, "") })}
                      className={`${FIELD} h-11 px-4`}
                    />
                  </label>
                  <FeeLine price={Number(edit.price)} />
                  <p className="mt-2 flex gap-2 text-[13px] text-muted">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Fixed: {packageTerms(p)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <button type="button" onClick={() => saveEdit(row.id)} disabled={!priceCents(edit.price) || busy} className={BTN_MAIN}>
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className={BTN_SIDE}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-foreground">{packageTitle(p)}</p>
                    {row.description && <p className="mt-0.5 text-[13px] text-foreground">{row.description}</p>}
                    <p className="mt-0.5 text-[13px] text-muted">{packageTerms(p)}</p>
                    <p className="mt-1.5 text-[14px] text-foreground">
                      {money(price)} <span className="text-muted">· you receive {money(creatorGets(price))}</span>
                    </p>
                    {!row.active && <p className="mt-1 text-[13px] font-semibold text-muted">Off, businesses can&apos;t book it</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(row.id);
                        setEdit({ title: row.title, description: row.description ?? "", price: String(price) });
                      }}
                      className={BTN_SMALL}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </button>
                    <button type="button" disabled={busy} onClick={() => void run(() => creatorApi.savePackage(row.id, { active: !row.active }))} className={BTN_SMALL}>
                      {row.active ? "Turn off" : "Turn on"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {adding ? (
        <div className="mt-4 rounded-2xl border border-black/[0.08] bg-black/[0.02] p-4">
          <p className="mb-4 text-[14px] font-semibold text-foreground">New package</p>
          <PackageBuilder value={adding} onChange={setAdding} />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={!priceCents(adding.price) || busy}
              onClick={async () => {
                const ok = await run(() => creatorApi.addPackage(toPackagePayload(adding)));
                if (ok) setAdding(null);
              }}
              className={BTN_MAIN}
            >
              {busy ? "Saving…" : "Save package"}
            </button>
            <button type="button" onClick={() => setAdding(null)} className={BTN_SIDE}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(defaultPackage())} className={`${BTN_SIDE} mt-3`}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add package
        </button>
      )}
    </Card>
  );
}
