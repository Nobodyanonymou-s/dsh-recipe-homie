// 诊断：把「像标题」但没被规则吃进去的行打出来，用来决定规则要不要加变体。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [, , OUT, BOOK, MODE = "nums"] = process.argv;
const dir = join(OUT, `${BOOK}_split`);
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort((a, b) => parseInt(a) - parseInt(b));

const NUM = "一二三四五六七八九十百零〇两\\d";
const RE_RECIPE = new RegExp(`^#{0,4}\\s*([${NUM}]+)\\s*、\\s*(.+)$`);

const seenHeadings = new Map();
const odd = [];
for (const f of files) {
  for (const raw of readFileSync(join(dir, f), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const key = line.slice(0, 6);
      seenHeadings.set(key, (seenHeadings.get(key) ?? 0) + 1);
    }
    const looksTitle = /^#{0,4}\s*[^\s]{1,12}、\s*\S/.test(line);
    if (looksTitle && !RE_RECIPE.test(line) && !/\.{3,}|…{2,}/.test(line)) odd.push(`${f}: ${line.slice(0, 80)}`);
  }
}

if (MODE === "heads") {
  [...seenHeadings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log(`${v}\t${k}`));
} else {
  console.log(`odd title-like lines: ${odd.length}`);
  odd.slice(0, 40).forEach((l) => console.log(l));
}
