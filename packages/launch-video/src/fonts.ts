import { cancelRender, continueRender, delayRender } from 'remotion';
import { FRAUNCES_WOFF2, JETBRAINS_MONO_WOFF2, SPACE_GROTESK_WOFF2 } from './fonts.data';

const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, ' +
  'U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, ' +
  'U+FEFF, U+FFFD';

interface FaceSpec {
  family: string;
  data: string;
  weight: string;
}

const FACES: FaceSpec[] = [
  { family: 'Fraunces', data: FRAUNCES_WOFF2, weight: '600' },
  { family: 'Fraunces', data: FRAUNCES_WOFF2, weight: '700' },
  { family: 'Space Grotesk', data: SPACE_GROTESK_WOFF2, weight: '400' },
  { family: 'Space Grotesk', data: SPACE_GROTESK_WOFF2, weight: '500' },
  { family: 'Space Grotesk', data: SPACE_GROTESK_WOFF2, weight: '600' },
  { family: 'Space Grotesk', data: SPACE_GROTESK_WOFF2, weight: '700' },
  { family: 'JetBrains Mono', data: JETBRAINS_MONO_WOFF2, weight: '400' },
  { family: 'JetBrains Mono', data: JETBRAINS_MONO_WOFF2, weight: '500' },
  { family: 'JetBrains Mono', data: JETBRAINS_MONO_WOFF2, weight: '700' },
];

const LOAD_TIMEOUT_MS = 18_000;
const LOAD_ATTEMPTS = 3;

function loadOrTimeout(face: FontFace): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`FontFace.load() did not settle within ${LOAD_TIMEOUT_MS}ms`)),
      LOAD_TIMEOUT_MS,
    );
    face.load().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

if (typeof document !== 'undefined' && typeof FontFace !== 'undefined') {
  const handle = delayRender(
    `Loading ${FACES.length} embedded woff2 faces (no network, no asset request)`,
    { timeoutInMilliseconds: 240_000 },
  );

  const loadAll = async (): Promise<void> => {
    for (const spec of FACES) {
      let lastErr: unknown = null;
      for (let left = LOAD_ATTEMPTS; left > 0; left--) {
        const face = new FontFace(
          spec.family,
          `url(data:font/woff2;base64,${spec.data}) format('woff2')`,
          { weight: spec.weight, style: 'normal', unicodeRange: LATIN_RANGE },
        );
        try {
          await loadOrTimeout(face);
          document.fonts.add(face);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) {
        throw new Error(
          `launch-video: embedded font ${spec.family} ${spec.weight} failed to load after ` +
            `${LOAD_ATTEMPTS} attempts (${spec.data.length} base64 chars in the bundle, no ` +
            `request made): ${String(lastErr)}`,
        );
      }
    }
  };

  loadAll().then(
    () => continueRender(handle),
    (err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))),
  );
}

export const serifFamily = 'Fraunces';

export const groteskFamily = 'Space Grotesk';

export const monoFamily = 'JetBrains Mono';

export const displayFamily = serifFamily;
export const sansFamily = groteskFamily;
