/**
 * 本地冒烟：不经过宿主，把注册的工具各调一遍。
 * 用法：node tools/smoke.mjs
 */
import { registerTools } from "../src/index.ts";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tools = new Map();
const ctx = { tools: { register: (t) => { tools.set(t.name, t); return () => {}; } } };
// 冒烟用独立画像/状态文件，别把真实 profile.json 覆盖掉
registerTools(ctx, {
  profileFile: join(ROOT, "data", "_smoke-profile.json"),
  stateFile: join(ROOT, "data", "_smoke-state.json"),
});
console.log("注册工具：", [...tools.keys()].join(", "));
// v0.2 契约：execute 返回结构化 canonical value（不再是 { text, card }）；
// 模型看 output.render(args, value) 产出的文本块，浏览器看 output.presentationMeta(args, value) 产出的卡片。
const callRaw = async (name, args) => {
  const tool = tools.get(name);
  const value = await tool.execute(args);
  const text = tool.output.render(args, value).map((b) => b.text ?? "").join("");
  const meta = tool.output.presentationMeta ? tool.output.presentationMeta(args, value) : null;
  return { text, meta, value };
};
const call = async (name, args) => (await callRaw(name, args)).text;

console.log("\n=== profile_show（初始）");
console.log(await call("profile_show"));

console.log("\n=== profile_update：建立画像");
await call("profile_update", { action: "set_household", size: 4, adults: 2, children: 2 });
await call("profile_update", { action: "like", target: "猪肉" });
await call("profile_update", { action: "like", target: "禽肉" });
await call("profile_update", { action: "dislike", target: "大蒜", hard: true });
await call("profile_update", { action: "allergy", target: "虾", allergen: "甲壳类" });
await call("profile_update", { action: "add_period", preset: "fitness", days: 30, goals: { proteinPerServing: 35 } });
await call("profile_update", { action: "set_skills", confident: ["蒸", "煮", "炒", "煎", "焖", "焗", "烤"], avoid: ["炸"] });

console.log("\n=== 记一条想吃的 + 记一顿做过的");
console.log(await call("profile_update", { action: "add_want", target: "冰糖元蹄" }));
console.log(await call("cook_log", {
  title: "冰糖元蹄", verdict: "loved",
  note: "炖得够久，皮很糯", people: 4,
  leftovers: [{ name: "猪蹄膀", grams: 300 }, { name: "小青菜", grams: 200 }],
}));

console.log("\n=== 太累时的退路");
console.log(await call("cook_rescue"));
console.log(await call("profile_show"));

console.log("\n=== recipe_search（按画像过滤）");
console.log((await call("recipe_search", { ingredients: ["五花肉", "冬笋"], match: "any", limit: 4 })).slice(0, 700));

console.log("\n=== recipe_get");
console.log((await call("recipe_get", { title: "冰糖元蹄" })).slice(0, 500));

console.log("\n=== plan_week（3 天 4 人）");
const plan = await call("plan_week", { days: 3, people: 4, meals: 2, seed: 42 });
console.log(plan.slice(0, 2200));

console.log("\n=== menu_shuffle ×3");
let exclude = [];
let reroll = 0;
for (let i = 0; i < 3; i++) {
  const out = await call("menu_shuffle", { people: 3, combo: "1菜1肉", excludeIds: exclude, rerollCount: reroll });
  console.log(out.split("\n").slice(0, 5).join("\n"));
  const m = out.match(/excludeIds=(\[.*?\])/);
  if (m) exclude = JSON.parse(m[1]);
  reroll++;
}

console.log("\n=== recommend（固定 3 候选 + 换一批不重复）");
const rec = await callRaw("recommend", { scene: "hungry", people: 2 });
console.log(rec.text);
const rec2 = await callRaw("recommend", { scene: "hungry", people: 2, excludeIds: rec.value.excludeIds });
const prevIds = new Set(rec.value.candidates.map((d) => d.id));
console.log(`换一批：${rec2.value.candidates.map((d) => d.title).join("/")}（${rec2.value.candidates.every((d) => !prevIds.has(d.id)) ? "不重复" : "重复了！"}）`);

console.log("\n=== 边界：不存在的菜 / 空搜索");
console.log(await call("recipe_get", { title: "没有这道菜" }));
console.log(await call("recipe_search", { ingredients: ["不存在的食材xyz"] }));

console.log("\n=== 卡片投影（presentationMeta）");
for (const [name, args] of [
  ["recipe_get", { id: "上海-001" }],
  ["recipe_search", { ingredients: ["五花肉"], limit: 3 }],
  ["plan_week", { days: 2, people: 3, meals: 1, seed: 7 }],
  ["menu_shuffle", { people: 2, seed: 5 }],
  ["recommend", { scene: "daily", people: 2 }],
  ["cook_rescue", {}],
]) {
  const { meta } = await callRaw(name, args);
  const ok = meta && typeof meta.kind === "string";
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} → kind=${meta?.kind ?? "none"} keys=${meta ? Object.keys(meta).length : 0}`);
  if (name === "recipe_get" && ok) console.log(`      卡片：${meta.title} · ${meta.ingredients.length} 料 · ${meta.steps.length} 步 · ${meta.minutes} 分钟 · 过敏原 ${meta.allergens.join(",") || "无"}`);
  if (name === "plan_week" && ok) console.log(`      卡片：${meta.menu.length} 天 · 采购一次买够 ${meta.shopping.buyOnce.length} 项 · 分批 ${meta.shopping.batches.length}`);
}
