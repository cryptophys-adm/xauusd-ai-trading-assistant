// RM1a: turns the saved Cloudflare query results (read-only SELECTs) into the study's JSON inputs.
//   node scripts/studies/rm1a/rm1a-extract.mjs <data dir> <saved files...>
import fs from "node:fs";
const [, , dir, ...files] = process.argv;
const decisions = [];
for (const f of files) {
  const t = fs.readFileSync(f, "utf8"); let j = JSON.parse(t.slice(t.indexOf("{")));
  if (typeof j === "string") j = JSON.parse(j);
  if (j.kind === "rm1a_bars") fs.writeFileSync(`${dir}/bars.json`, JSON.stringify(j));
  else if (j.kind === "rm1a_decisions") decisions.push(...j.rows);
  console.log(f.split("/").pop(), j.kind, JSON.stringify(j.n));
}
const seen = new Set(); const uniq = decisions.filter((d) => !seen.has(d.decision_key) && seen.add(d.decision_key));
uniq.sort((a, b) => a.bar_close.localeCompare(b.bar_close));
fs.writeFileSync(`${dir}/decisions.json`, JSON.stringify(uniq));
console.log("decisions", uniq.length, uniq[0].bar_close, uniq.at(-1).bar_close);
