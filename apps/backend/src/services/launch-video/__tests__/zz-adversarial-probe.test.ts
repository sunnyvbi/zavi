import { describe, it, expect } from "vitest";
import { checkAuthoredFilm } from "../authored-film";

const wrap = (body: string, frames = 1800) => `
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
export const AUTHORED_FRAMES = ${frames};
export const AuthoredFilm: React.FC = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#fff' }}>${body}</AbsoluteFill>;
};
${"// padding padding padding padding padding padding\n".repeat(15)}
`;

const cases: Array<[string, string]> = [
  ["svg use xlinkHref abs", `<svg><use xlinkHref="https://ex.test/t" /></svg>`],
  ["svg image xlinkHref abs", `<svg><image xlinkHref="https://ex.test/t" /></svg>`],
  ["object data abs", `<object data="https://ex.test/t" />`],
  ["style @import string", `<style>{"@import 'https://ex.test/x.css';"}</style>`],
  ["embed src abs", `<embed src="https://ex.test/t" />`],
  ["video poster abs", `<video poster="https://ex.test/t" />`],
  ["td background attr", `<div background="https://ex.test/t" />`],
  ["unicode bullet glyph", `<div>{'\\u2022 feature one'}</div>`],
  ["copy contains 'url ('", `<div>Visit the url (below)</div>`],
  ["camelCase buildUrl call", `<div>{(function buildUrl(){return 'x'})()}</div>`],
  ["data uri inline svg literal", `<img src="data:image/svg+xml;utf8,<svg/>" />`],
  ["staticFile computed src", `<img src={'hero.png'} />`],
  ["copy 'export data from apps'", `<div>{"export data from 'apps' now"}</div>`],
];

describe("adversarial probe", () => {
  for (const [name, body] of cases) {
    it(name, () => {
      const r = checkAuthoredFilm(wrap(body), 1800);
      // eslint-disable-next-line no-console
      console.log(`PROBE ${r.ok ? "PASS-GATE" : "REJECT"} :: ${name} :: ${r.ok ? "" : (r as any).error}`);
      expect(true).toBe(true);
    });
  }
});
