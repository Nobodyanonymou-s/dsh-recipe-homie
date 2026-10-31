/**
 * 词表探针：把 2,753 个原料名按「去形态词 + 去修饬词」归组，看看能收敛到多少。
 * 产物：data/lexicon-groups.json（供人工核对/立表）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const freq = JSON.parse(readFileSync(`${ROOT}/data/ingredient-freq.json`, "utf8"));

// 形态词：切法，不影响是什么东西
const FORM = /(末|片|丝|块|粒|条|段|结|汁|泥|茸|丁|球|米|碎|粉|卷|花|皮|骨|汤)$/;
// 修饰词：熟成/干制/部位/大小/肥瘦
const QUAL = /^(熟|生|鲜|干|水发|水浸|浸发|发|净|瘦|肥|嫩|老|土|大|小|细|粗|上|好|精|纯|淡|白|红|青|黄|黑|绿|金|银|去骨|带皮|去皮|无皮|整|半|新|陈|特|一|二|三)/;

function base(name) {
  let s = name.replace(/[\s*＊〔〕[\]（）()]/g, "");
  for (let i = 0; i < 3; i++) {
    const t = s.replace(QUAL, "");
    s = t === s ? s : t;
  }
  for (let i = 0; i < 2; i++) {
    const t = s.replace(FORM, "");
    s = t === s ? s : t;
  }
  return s;
}

const groups = new Map();
for (const [name, count] of freq) {
  const b = base(name) || name;
  const g = groups.get(b) ?? { base: b, total: 0, members: [], max: 0 };
  g.total += count;
  g.max = Math.max(g.max, count);
  g.members.push([name, count]);
  groups.set(b, g);
}

const list = [...groups.values()]
  .map((g) => ({ ...g, members: g.members.sort((a, b2) => b2[1] - a[1]) }))
  .sort((a, b2) => b2.total - a.total);

writeFileSync(`${ROOT}/data/lexicon-groups.json`, JSON.stringify(list, null, 1), "utf8");

console.log(`原料名 ${freq.length} → 组 ${list.length}`);
const head = list.slice(0, 160);
for (const g of head) {
  console.log(`${String(g.total).padStart(5)} ${g.base}  ←  ${g.members.slice(0, 6).map((m) => m[0]).join(" / ")}${g.members.length > 6 ? ` (+${g.members.length - 6})` : ""}`);
}
const covered = head.reduce((s, g) => s + g.total, 0);
const allRows = freq.reduce((s, x) => s + x[1], 0);
console.log(`\n前160组覆盖 ${covered}/${allRows} 行 (${((covered / allRows) * 100).toFixed(1)}%)`);
