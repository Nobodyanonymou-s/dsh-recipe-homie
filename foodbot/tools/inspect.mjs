// 抽查：node tools/inspect.mjs [id或序号...]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lines = readFileSync(`${ROOT}/data/recipes.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const picks = process.argv.slice(2);
const chosen = picks.length
  ? lines.filter((r) => picks.some((p) => r.id === p || String(lines.indexOf(r)) === p || r.title.includes(p)))
  : [lines[0], lines[Math.floor(lines.length / 2)], lines[lines.length - 1]];

for (const r of chosen) {
  console.log(`\n${r.id}  ${r.title}  [${r.cuisine}·${r.chapter}]  ${r.pages.join(",")}${r.needsTitle ? "  ⚠标题缺失" : ""}`);
  console.log(`  原料 ${r.ingredients.length} 项：` + r.ingredients.slice(0, 6).map((i) => `${i.name}${i.amount ? "=" + i.amount : ""}${i.grams ? `(${i.grams}g)` : ""}`).join("；"));
  console.log(`  步骤 ${r.steps.length} 步：${(r.steps[0] ?? "").slice(0, 60)}…`);
  console.log(`  特点：${(r.features ?? "").slice(0, 50)}`);
  console.log(`  技法/口味：${r.methods.join("/") || "-"} | ${r.flavors.join("/") || "-"}`);
}
console.log(`\n总记录 ${lines.length}；标题缺失 ${lines.filter((r) => r.needsTitle).length}`);
