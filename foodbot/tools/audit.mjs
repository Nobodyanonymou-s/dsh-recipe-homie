// 数据审计：克数覆盖率、单位异常、营养与难度分布
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const L = readFileSync(`${ROOT}/data/recipes.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const rows = L.flatMap((r) => r.ingredients);

const withGrams = rows.filter((i) => i.grams);
console.log(`原料行 ${rows.length}｜有克数 ${withGrams.length} (${((withGrams.length / rows.length) * 100).toFixed(1)}%)｜适量类 ${rows.filter((i) => i.qualifier).length}｜猜测归类 ${rows.filter((i) => i.guessed).length} (${((rows.filter((i) => i.guessed).length / rows.length) * 100).toFixed(1)}%)`);

const by = new Map();
for (const i of rows) {
  const o = by.get(i.canon) ?? { n: 0, g: 0, sum: 0 };
  o.n++;
  if (i.grams) { o.g++; o.sum += i.grams; }
  by.set(i.canon, o);
}
console.log("\n高频原料（行数/有克数/均值g）：");
console.log([...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 24)
  .map(([k, o]) => `${k}:${o.n}/${o.g}/${o.g ? Math.round(o.sum / o.g) : "-"}`).join("  "));

// 异常值：单条原料 > 2kg，除了整鸡整鱼整蹄膀
const weird = rows.filter((i) => i.grams > 2000).map((i) => `${i.canon}=${i.grams}g(${i.amount})`);
console.log(`\n>2kg 的原料 ${weird.length} 条：${weird.slice(0, 15).join("  ")}`);

const p = L.map((r) => r.perServing.proteinGrams).sort((a, b) => a - b);
const q = (x) => p[Math.floor(p.length * x)];
console.log(`\n每人蛋白中位数 ${q(0.5)}g｜P90 ${q(0.9)}g｜P10 ${q(0.1)}g`);
const skill = {};
for (const r of L) skill[r.skill.tier] = (skill[r.skill.tier] ?? 0) + 1;
console.log("难度分布:", skill);

const r = L.find((x) => x.title === "冰糖元蹄");
console.log("\n冰糖元蹄:", JSON.stringify({
  srv: r.servingsBase, nut: r.nutrition, per: r.perServing, skill: r.skill,
  allergen: r.allergens, main: r.mainCanon, blurb: r.blurb,
}, null, 1));

const hi = L.filter((x) => x.skill.tier === "easy" && x.perServing.proteinGrams >= 30).slice(0, 5);
console.log("\n易做且高蛋白例:", hi.map((x) => `${x.title}(${x.perServing.proteinGrams}g/人)`).join(" | "));
