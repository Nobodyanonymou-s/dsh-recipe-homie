/**
 * 建库：把 OCR 切片解析成 data/recipes.jsonl + data/index.json。
 * 用法：node src/build.mjs [册名...]   不带参数 = 全部《中国菜谱》分册
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBook } from "./parse.mjs";
import { enrichRecipe } from "./enrich.mjs";
import { cleanupRecipe } from "./cleanup.mjs";
import { LEXICON_STATS } from "./ingredients.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OCR = resolve(ROOT, "..", "OCR处理菜谱", "vibe_coding", "output");
const DATA = join(ROOT, "data");

const BOOKS = [
  ["中国菜谱 上海", "上海"],
  ["中国菜谱 北京", "北京"],
  ["中国菜谱 江苏", "江苏"],
  ["中国菜谱 浙江", "浙江"],
  ["中国菜谱 广东", "广东"],
  ["中国菜谱 安徽", "安徽"],
  ["中国菜谱 山东", "山东"],
  ["中国菜谱 湖北", "湖北"],
  ["中国菜谱 湖南", "湖南"],
  ["中国菜谱 陕西", "陕西"],
];

function pagesOf(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
}

const wanted = process.argv.slice(2);
const chosen = wanted.length ? BOOKS.filter(([name]) => wanted.some((w) => name.includes(w))) : BOOKS;

const all = [];
const report = [];
for (const [name, cuisine] of chosen) {
  const dir = join(OCR, `${name}_split`);
  if (!existsSync(dir)) {
    report.push({ book: name, error: "切片目录不存在" });
    continue;
  }
  const files = pagesOf(dir);
  const { recipes: parsed, orphanTitles } = parseBook({ book: `中国菜谱·${cuisine}`, cuisine, files });
  const cleaned = parsed.map(cleanupRecipe);
  // 同一册里出现两次同名菜 = 标题与内容大概率串行了（OCR 把标题挪了位），标出来，别混进菜单
  const titleCount = new Map();
  for (const r of cleaned) {
    const k = `${r.book}::${r.title}`;
    titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
  }
  const recipes = cleaned.map((r) => enrichRecipe({ ...r, suspectTitle: (titleCount.get(`${r.book}::${r.title}`) ?? 0) > 1 }));
  all.push(...recipes);
  const unmapped = new Map();
  for (const r of parsed) {
    for (const ing of r.ingredients) {
      if (ing.guessed) unmapped.set(ing.name, (unmapped.get(ing.name) ?? 0) + 1);
    }
  }
  report.push({
    book: name,
    pages: files.length,
    recipes: recipes.length,
    needsTitle: orphanTitles.length,
    withIngredients: recipes.filter((r) => r.ingredients.length > 0).length,
    withSteps: recipes.filter((r) => r.steps.length > 0).length,
    withFeatures: recipes.filter((r) => r.features).length,
    avgIngredients: +(recipes.reduce((s, r) => s + r.ingredients.length, 0) / (recipes.length || 1)).toFixed(1),
    unmappedNames: [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}(${v})`),
    chapters: [...new Set(recipes.map((r) => r.chapter))].filter(Boolean),
  });
}

// ---- 索引 ----
const index = {
  version: 2,
  builtAt: new Date().toISOString(),
  lexicon: LEXICON_STATS,
  ids: {},
  byCuisine: {},
  byChapter: {},
  byMethod: {},
  byFlavor: {},
  byIngredient: {},
  byCanon: {},
  byBook: {},
  bySkill: {},
  byAllergen: {},
};

const add = (map, key, id) => {
  if (!key) return;
  (map[key] ??= []).push(id);
};

for (const r of all) {
  index.ids[r.id] = { title: r.title, cuisine: r.cuisine, book: r.book, chapter: r.chapter };
  add(index.byCuisine, r.cuisine, r.id);
  add(index.byChapter, r.chapter, r.id);
  add(index.byBook, r.book, r.id);
  add(index.bySkill, r.skill?.tier, r.id);
  for (const m of r.methods) add(index.byMethod, m, r.id);
  for (const f of r.flavors) add(index.byFlavor, f, r.id);
  for (const ing of r.ingredients) {
    add(index.byIngredient, ing.key, r.id);
    add(index.byCanon, ing.canon, r.id);
  }
  for (const a of r.allergens ?? []) add(index.byAllergen, a, r.id);
}

const unmappedTotal = all.reduce((s, r) => s + r.ingredients.filter((i) => i.guessed).length, 0);
const ingTotal = all.reduce((s, r) => s + r.ingredients.length, 0);
const stats = {
  recipes: all.length,
  ingredients: ingTotal,
  unmapped: unmappedTotal,
  canonUsed: Object.keys(index.byCanon).length,
  bySkill: Object.fromEntries(Object.entries(index.bySkill).map(([k, v]) => [k, v.length])),
  dominant: Object.entries(index.byCanon).sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([k, v]) => `${k}(${v})`),
};

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "recipes.jsonl"), all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
writeFileSync(join(DATA, "index.json"), JSON.stringify(index), "utf8");
writeFileSync(join(DATA, "build-report.json"), JSON.stringify({ stats, books: report }, null, 2), "utf8");

console.log(JSON.stringify({
  total: all.length,
  lexicon: LEXICON_STATS,
  unmappedRate: +((unmappedTotal / (ingTotal || 1)) * 100).toFixed(1) + "%",
  bySkill: stats.bySkill,
  books: report.map((r) => `${r.book}:${r.recipes}`),
  mb: +(readFileSync(join(DATA, "recipes.jsonl")).length / 1e6).toFixed(2),
}, null, 2));
