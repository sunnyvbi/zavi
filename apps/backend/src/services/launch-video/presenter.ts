
export const PRESENTER_GENDERS = ["male", "female"] as const;
export type PresenterGender = (typeof PRESENTER_GENDERS)[number];

export const PRESENTER_VOICES: Record<string, PresenterGender> = {
  Brian: "male",
  Chris: "male",
  Will: "male",
  Liam: "male",
  Eric: "male",
  Roger: "male",
  Bill: "male",
  George: "male",
  Daniel: "male",
  Charlie: "male",
  Callum: "male",
  Sarah: "female",
  Jessica: "female",
  Laura: "female",
  Aria: "female",
  Matilda: "female",
  Alice: "female",
  Lily: "female",
  Charlotte: "female",
};

export const PRESENTER_VOICE_NAMES = Object.keys(PRESENTER_VOICES);

export const FALLBACK_VOICE: Record<PresenterGender, string> = { male: "Chris", female: "Jessica" };

export const TALKING_HEAD_VOICE_STABILITY = 0.3;

export const UNSPECIFIED_PRESENTER_VOICE = "Brian";

const voiceNamed = (voice?: string): string | undefined => {
  const wanted = (voice ?? "").trim().toLowerCase();
  if (!wanted) return undefined;
  return PRESENTER_VOICE_NAMES.find((v) => v.toLowerCase() === wanted);
};

export function resolvePresenterVoice(p: { gender?: PresenterGender; voice?: string }): string {
  if (!p.gender) return UNSPECIFIED_PRESENTER_VOICE;
  const named = voiceNamed(p.voice);
  return named && PRESENTER_VOICES[named] === p.gender ? named : FALLBACK_VOICE[p.gender];
}

const WHO: Record<PresenterGender, string> = { male: "a man", female: "a woman" };

export function talkingHeadPortraitPrompt(scene: string, gender?: PresenterGender): string {
  const described = scene.trim().replace(/[.\s]+$/, "");
  const who = gender ? WHO[gender] : "a presenter";
  return [
    `Vertical phone-camera photo of ${who} about to speak to the camera`,
    described,
    gender ? `The person on camera is ${who}` : "",
    "Medium close-up from the chest up, head and shoulders in the upper half of the frame, eyes about a third of the way down, facing the lens directly, mouth closed and relaxed",
    "Hands out of frame, nothing held, nothing covering the face",
    "Soft natural light, real skin texture, no text, captions or logos anywhere",
  ]
    .filter(Boolean)
    .join(". ")
    .concat(".");
}
