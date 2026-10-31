/**
 * 把子任务给的词表补全合并成源码里的 `src/lexicon-extra.ts`。
 *
 * 不直接改 lexicon.ts 正文：那 260 条是手写的，文本改动容易碰坏；
 * 这里生成一个补充模块，由 lexicon.ts 在末尾 push 进 CANON。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE } from "../src/lexicon.ts";
import { lookup } from "../src/ingredients.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(readFileSync(`${ROOT}/data/work/lexicon-additions.json`, "utf8").replace(/^\uFEFF/, ""));

const known = new Set(BASE.map((e) => e.id));
const knownAlias = new Set(BASE.flatMap((e) => [e.id, ...(e.aliases ?? [])]));
const byCanon = new Map();
const skipped = [];
// 噪声别名：OCR 省略号、带分量后缀、过长
const noisy = (raw) => /[…·]|\.{2,}/.test(raw) || raw.length > 12 || /(斤|两|钱|分|克)$/.test(raw) || /^[0-9]/.test(raw);

// 第一遍：先把 new_canon 立住，alias_of 才可能有目标
for (const a of src) {
  if (a?.action !== "new_canon") continue;
  const id = String(a.canon ?? a.raw ?? "").replace(/\s+/g, "");
  if (!id || known.has(id)) continue;
  known.add(id);
  byCanon.set(id, {
    id,
    parent: a.parent ?? "其他",
    cat: a.cat ?? "其他",
    allergen: a.allergen ?? [],
    aliases: new Set(),
    isNew: true,
  });
}

for (const a of src) {
  if (!a?.raw) continue;
  const raw = String(a.raw).replace(/\s+/g, "");
  if (!raw) continue;
  const target = a.canon;
  if (!target) { skipped.push([raw, "无目标"]); continue; }
  if (knownAlias.has(raw)) { skipped.push([raw, "已存在"]); continue; }
  if (noisy(raw) && raw !== target) { skipped.push([raw, "噪声别名"]); continue; }
  // 目标标准名不存在时，用本条带过来的 parent/cat 就地立一个（子任务常这么写：药材、卤水、锅巴）
  if (!known.has(target)) {
    known.add(target);
    byCanon.set(target, { id: target, parent: a.parent ?? "其他", cat: a.cat ?? "其他", allergen: a.allergen ?? [], aliases: new Set(), isNew: true });
  }
  const g = byCanon.get(target) ?? {
    id: target,
    parent: a.parent ?? "其他",
    cat: a.cat ?? "其他",
    allergen: a.allergen ?? [],
    aliases: new Set(),
  };
  // alias_of：raw 是异名；new_canon：raw 就是标准名本身，不用再记别名
  if (a.action === "alias_of" && raw !== target) g.aliases.add(raw);
  byCanon.set(target, g);
  knownAlias.add(raw);
}

const entries = [...byCanon.values()].filter((e) => !knownAlias.has(e.id) || e.aliases.size || e.isNew);
const lines = entries.map((e) => {
  const alias = [...e.aliases].filter((x) => x !== e.id);
  return `  { id: ${JSON.stringify(e.id)}, parent: ${JSON.stringify(e.parent)}, cat: ${JSON.stringify(e.cat)}, unit: ${JSON.stringify(e.cat === "蛋奶" ? "count" : "g")}, allergen: ${JSON.stringify(e.allergen)}, aliases: ${JSON.stringify(alias)} },`;
});

const body = `/**
 * 词表补充（由 tools/merge-lexicon.ts 从 data/work/lexicon-additions.json 生成）。
 * 这些是子任务从 2,877 道菜的实际用词里挖出来的异名与新概念，别手改——改上游再重生成。
 */
export const EXTRA = [
${lines.join("\n")}
];
`;
writeFileSync(`${ROOT}/src/lexicon-extra.ts`, body, "utf8");

console.log(JSON.stringify({
  source: src.length,
  merged: entries.length,
  aliases: entries.reduce((s, e) => s + e.aliases.size, 0),
  newCanon: entries.filter((e) => !known.has(e.id)).length,
  skipped: skipped.length,
  skippedSample: skipped.slice(0, 8),
}, null, 2));

// 顺便验一下覆盖：合并前 lookup 命不中的，合并后能命中多少
const still = src.filter((a) => !lookup(a.raw));
console.log(`合并后仍 lookup 不中：${still.length} / ${src.length}`);
