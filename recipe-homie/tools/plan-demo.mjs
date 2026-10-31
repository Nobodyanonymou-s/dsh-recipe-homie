/**
 * 场景演练：用一份"真实用户"画像跑规划，看菜单和采购清单合不合理。
 * 用法：node tools/plan-demo.mjs [天数] [人数]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RecipeBook } from "../src/query.mjs";
import { Planner } from "../src/planner.mjs";
import { DEFAULT_PROFILE } from "../src/profile.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presets = JSON.parse(readFileSync(`${ROOT}/data/presets.json`, "utf8")).presets;

const days = Number(process.argv[2] ?? 3);
const people = Number(process.argv[3] ?? 4);

const profile = {
  ...DEFAULT_PROFILE,
  household: { size: people, adults: people, children: 0, note: "" },
  longTerm: {
    likes: [{ target: "猪肉", weight: 2 }, { target: "禽肉", weight: 2 }],
    dislikes: [{ target: "大蒜", weight: -3, hard: true }],
    allergies: [{ target: "虾", allergen: "甲壳类" }],
    avoid: [],
    diet: { noPork: false, vegetarian: false, noBeef: false, noSeafood: false, halal: false },
  },
  periods: [
    { id: "fit", label: "健身增肌", preset: "fitness", start: "2026-10-01", end: "2026-12-31", goals: { proteinPerServing: 35 }, avoidCanon: [], avoidMethods: [] },
  ],
  skills: {
    confident: ["蒸", "煮", "炒", "煎", "焖", "焗", "烤", "空气炸锅"],
    avoid: ["炸"],
    willing: [],
  },
};

const book = new RecipeBook(`${ROOT}/data`);
const planner = new Planner(book, profile, presets);
planner.refresh();

console.log(`候选池：`);
const pools = planner.pools();
console.log(`  主菜 ${pools.protein.length}｜素菜 ${pools.veg.length}｜汤 ${pools.soup.length}`);
console.log(`  约束：蛋白目标 ${planner.c.proteinTarget}g/人｜过敏原 ${[...planner.c.blockedAllergens].join(",") || "-"}｜禁技法 ${[...planner.c.bannedMethods].join(",") || "-"}`);

const result = planner.plan({ days, people, meals: 2, seed: 42 });
console.log(`\n=== ${days} 天 × ${people} 人计划 ===`);
for (const day of result.plan) {
  console.log(`\n第 ${day.day} 天`);
  for (const meal of day.meals) {
    console.log(`  ${meal.name}（蛋白 ${meal.protein}g/人，热量 ${meal.kcal}kcal）`);
    for (const d of meal.dishes) {
      console.log(`    · ${d.title} [${d.cuisine}·${d.chapter}] ${d.role} ｜ ${d.blurb} ｜ 用量×${d.scale}`);
    }
  }
}
if (result.notes.length) console.log(`\n提示：\n  ${result.notes.join("\n  ")}`);

const s = result.shopping;
console.log(`\n=== 采购清单 ===`);
console.log(`\n${s.buyOnce.label}`);
for (const i of s.buyOnce.items) console.log(`  ${i.name}  ${i.qty}`);
for (const b of s.batches) {
  console.log(`\n${b.label}`);
  for (const i of b.items) console.log(`  ${i.name}  ${i.qty}  （第${i.days.join(",")}天用）`);
}
console.log(`\n${s.dry.label}`);
for (const i of s.dry.items) console.log(`  ${i.name}  ${i.qty}`);
console.log(`\n${s.staples.label}`);
for (const i of s.staples.items) console.log(`  ${i.name}  ${i.qty}`);
if (s.selfMade.items.length) {
  console.log(`\n${s.selfMade.label}`);
  for (const i of s.selfMade.items) console.log(`  ${i.name}  ${i.qty}`);
}
if (s.keep.length) {
  console.log(`\n蛋奶/豆制品`);
  for (const i of s.keep) console.log(`  ${i.name}  ${i.qty}`);
}

console.log(`\n=== 随机挑战（2-3 人一菜一肉）===`);
let exclude = [];
for (let i = 1; i <= 3; i++) {
  const r = planner.shuffle({ people: 2, combo: "1菜1肉", excludeIds: exclude, seed: 100 + i, rerollCount: i - 1 });
  console.log(`第${i}次：${r.dishes.map((d) => `${d.title}(${d.role})`).join(" + ")}`);
  exclude = r.excludeIds;
  if (r.askReason) console.log(`  → ${r.hint}`);
}
