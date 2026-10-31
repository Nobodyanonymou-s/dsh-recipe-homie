// 一次性探针：不产出正式数据，只测「规则能否切开老菜谱」。
// 用法: node tools/probe.mjs <output目录> <书名...>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const BOOKS = process.argv.slice(3);

const NUM = "一二三四五六七八九十百零〇两\\dOo";
const RE_RECIPE = new RegExp(`^#{0,4}\\s*([${NUM}]+)\\s*、\\s*(.+)$`);

// 中文/阿拉伯序号 → 整数，用来找漏掉的条目
function seqNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const D = { 零: 0, 〇: 0, O: 0, o: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let num = 0;
  let tmp = 0;
  for (const ch of s) {
    if (ch === "百") { num += (tmp || 1) * 100; tmp = 0; }
    else if (ch === "十") { num += (tmp || 1) * 10; tmp = 0; }
    else if (D[ch] !== undefined) { tmp = D[ch]; }
  }
  return num + tmp;
}
const RE_TOC = /(\.{3,}|…{2,}|\(\s*\d+\s*\)|（\s*\d+\s*）)\s*$/;
const RE_SECTION = /^#{0,4}\s*(原\s*料|制\s*法|做\s*法|特\s*点|附\s*注|注\s*释|注)\s*[：:]?\s*$/;
const SECTION_MAP = { 原料: "ingredients", 制法: "steps", 做法: "steps", 特点: "features", 附注: "notes", 注: "notes", 注释: "notes" };

function pagesOf(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
}

function parseBook(name) {
  const dir = join(OUT, `${name}_split`);
  const pages = pagesOf(dir);
  const recipes = [];
  let cur = null;
  let section = null;
  let midPageStarts = 0;

  const push = () => {
    if (cur && cur.title) recipes.push(cur);
  };

  for (const page of pages) {
    const lines = page.text.split(/\r?\n/);
    const firstMeaningful = lines.findIndex((l) => l.trim() !== "" && !l.startsWith("![](") && !l.includes("<div"));
    const startsWithHeading = firstMeaningful >= 0 && /^\s*#{1,4}\s/.test(lines[firstMeaningful] ?? "");
    if (!startsWithHeading) midPageStarts++;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("![](") || line.includes("<div") || line === "</div>" || line.startsWith("[TOC]")) continue;
      const sec = line.match(RE_SECTION);
      if (sec) {
        section = SECTION_MAP[sec[1].replace(/\s/g, "")] ?? "other";
        if (cur && !cur[section]) cur[section] = [];
        continue;
      }
      const m = line.match(RE_RECIPE);
      if (m && !RE_TOC.test(line) && m[2].length <= 30) {
        // 目录条目形如「一、冰糖元蹄...( 3 )」，已排除；剩下的当作新菜
        push();
        cur = { title: m[2].trim().replace(/[（(].*?[）)]$/, ""), seq: m[1], sections: {}, pages: [page.file] };
        section = null;
        continue;
      }
      if (!cur) continue;
      if (page.file !== cur.pages[cur.pages.length - 1] && !cur.pages.includes(page.file)) cur.pages.push(page.file);
      if (!section) {
        cur.intro = (cur.intro ?? "") + line;
        continue;
      }
      (cur[section] ??= []).push(line.replace(/^[-*]\s*/, ""));
    }
  }
  push();

  const clean = recipes
    .filter((r) => r.ingredients?.length || r.steps?.length)
    .map((r) => ({
      title: r.title,
      seq: r.seq,
      pages: r.pages,
      nIng: (r.ingredients ?? []).length,
      nStep: (r.steps ?? []).length,
      nFeat: (r.features ?? []).length,
      nNote: (r.notes ?? []).length,
    }));

  const titles = clean.map((r) => r.title);
  const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
  const seqs = clean.map((r) => seqNum(r.seq)).filter((n) => n > 0);
  const maxSeq = Math.max(0, ...seqs);
  const seen = new Set(seqs);
  const missing = [];
  for (let i = 1; i <= maxSeq; i++) if (!seen.has(i)) missing.push(i);
  return {
    book: name,
    pages: pages.length,
    midPageStarts,
    recipes: clean.length,
    maxSeq,
    missingCount: missing.length,
    missingSample: missing.slice(0, 12),
    withIngredients: clean.filter((r) => r.nIng > 0).length,
    withSteps: clean.filter((r) => r.nStep > 0).length,
    withFeatures: clean.filter((r) => r.nFeat > 0).length,
    dupTitles: [...new Set(dup)].slice(0, 6),
    avgIng: +(clean.reduce((s, r) => s + r.nIng, 0) / clean.length).toFixed(1),
    sample: clean.slice(0, 2),
    tail: clean.slice(-2),
  };
}

const report = BOOKS.map(parseBook);
console.log(JSON.stringify(report, null, 2));
