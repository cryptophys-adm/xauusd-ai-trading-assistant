// SV1a (read-only study): turns the saved Cloudflare query results into the study's JSON inputs.
//   node scripts/studies/sv1a-extract.mjs <dir> <saved query result files...>
import fs from "node:fs";
const [, , dir, ...files] = process.argv;
const decisions = [];
for (const f of files) {
  const t = fs.readFileSync(f, "utf8"); const j = JSON.parse(t.slice(t.indexOf("{")));
  if (j.kind === "sv1a_corpus_bars") fs.writeFileSync(`${dir}/corpus_bars.json`, JSON.stringify(j));
  else if (j.kind === "sv1a_ledger_omega4") fs.writeFileSync(`${dir}/ledger_omega4.json`, JSON.stringify(j));
  else if (j.kind === "sv1a_decisions") decisions.push(...j.rows);
  console.log(f.slice(-12), j.kind, j.n ?? j.counts);
}
decisions.sort((a, b) => a.bar_close.localeCompare(b.bar_close));
fs.writeFileSync(`${dir}/decisions.json`, JSON.stringify(decisions));
console.log("decisions", decisions.length, decisions[0].bar_close, decisions.at(-1).bar_close);
