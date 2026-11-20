import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const DIR = process.env.VERDICT_REPLAY_DIR ?? ".verdict-replay-fleet";
const A = `${DIR}/assembled`, C = `${DIR}/columns`;

const role = (slug) =>
  `You are the ${slug.replace(/_/g, " ")} growth agent for this business. Give the owner the few actions that matter most.\n`;

const hardRules = (cores) => {
  const i = cores.indexOf("## Hard rules");
  if (i < 0) return "";
  const j = cores.indexOf("\n## ", i + 4);
  return j < 0 ? cores.slice(i) : cores.slice(i, j);
};

for (const f of readdirSync(A).filter((x) => x.endsWith(".parts.json"))) {
  const d = JSON.parse(readFileSync(`${A}/${f}`, "utf8"));
  const slug = d.slug;
  const full = `${d.cores}\n\n${d.agent}\n\n${d.skills}\n\n${d.recipe}\n\nROUTER:\n${d.router}`;
  const thin = `${hardRules(d.cores)}\n\nTHIS CHANNEL'S STEPS:\n${d.goals}\n`;
  writeFileSync(`${C}/ships-today.${slug}.md`, full);
  writeFileSync(`${C}/plain.${slug}.md`, role(slug));
  writeFileSync(`${C}/thin-recipe.${slug}.md`, thin);
  console.log(
    `${slug.padEnd(20)} ships-today=${full.length} thin=${thin.length} plain=${role(slug).length}` +
    (hardRules(d.cores) ? "" : "  WARNING: no '## Hard rules' block found in cores, thin lane has NO safety text"),
  );
}
