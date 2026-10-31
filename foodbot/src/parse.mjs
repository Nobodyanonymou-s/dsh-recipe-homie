/**
 * 《中国菜谱》系列（各省分册）的 Markdown → 结构化菜谱记录。
 *
 * 输入是 GLM-OCR 按 5 页切片的产出：output/<书名>_split/1.md, 2.md, ...
 * 这一层的原则：**忠实原文**。原句、原始分量（斤/两/钱/分）一个字不改，只在旁边
 * 加派生字段（食材名、折算克数、技法/口味标签）。派生错了可以重建，原文丢了就没了。
 */
import { lookup, parseAmount } from "./ingredients.mjs";

const NUM = "一二三四五六七八九十百零〇两\\dOo";
const RE_RECIPE = new RegExp(`^#{0,4}\\s*([${NUM}]+)\\s*、\\s*(.+)$`);
const RE_TOC = /(\.{3,}|…{2,}|\(\s*\d+\s*\)|（\s*\d+\s*）)\s*$/;
const RE_SECTION = /^#{0,4}\s*(原\s*料|制\s*[法注汁]|做\s*法|特\s*点|附\s*注|注\s*释|注|则\s*法)\s*[：:]?\s*$/;
const SECTION_MAP = { 原料: "ingredients", 制法: "steps", 制注: "steps", 制汁: "steps", 则法: "steps", 做法: "steps", 特点: "features", 附注: "notes", 注: "notes", 注释: "notes" };
// OCR 会把小节名啃成单个字：整行只有一个「料」或「法」
const BARE_SECTION = { 料: "ingredients", 法: "steps" };
// 原料行里的交叉引用，不是"嵌入的配菜做法"
const CROSS_REF = /见\s*[「“"']|参见|参照|同\s*[「“"']|详见/;
const SENTENCE_END = /[。！？…”』」]$/;

const CN_DIGIT = { 零: 0, 〇: 0, O: 0, o: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文/阿拉伯序号 → 整数。OCR 常漏「百」，只用于辅助排序，不用于计数。 */
export function seqNumber(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let num = 0;
  let tmp = 0;
  for (const ch of s) {
    if (ch === "百") { num += (tmp || 1) * 100; tmp = 0; }
    else if (ch === "十") { num += (tmp || 1) * 10; tmp = 0; }
    else if (CN_DIGIT[ch] !== undefined) { tmp = CN_DIGIT[ch]; }
  }
  return num + tmp;
}

/** 市制 → 克。1959 年后十两制：1斤=500g，1两=50g，1钱=5g，1分=0.5g。 */
const UNIT_G = { 千克: 1000, 公斤: 1000, 斤: 500, 两: 50, 钱: 5, 克: 1, 分: 0.5 };

/**
 * 从不规范的分量文本里折算克数（仅作参考）。
 * 支持「一两五钱」「一钱半」「二斤（约耗二两）」「一条（约重一斤半）」。
 * 拿不准时返回 null —— 宁可空着，不要给错数。
 */
export function toGrams(amountText) {
  if (!amountText) return null;
  let text = amountText;
  const approx = text.match(/约重\s*([^）)]+)/);
  if (approx) text = approx[1];
  else text = text.replace(/[（(][^）)]*[）)]/g, " ");

  let total = 0;
  let hit = false;
  let lastUnit = null;
  // 「两」只是单位不是数字（数字类不含「两」），单独的「两斤/两钱」（=2斤/2钱）走独立分支
  const re = /([0-9]+|两|[零〇一二三四五六七八九十百]+)\s*(千克|公斤|斤|两|钱|克|分)/g;
  for (const m of text.matchAll(re)) {
    const tok = m[1];
    const unit = m[2];
    // 「三、四朵」「五、六钱」这类区间不折算：纯个位数字连写才可能是区间；
    // 「两」已从数字类移除，「一两五」这类两钱复合不会再被当区间整段吞掉（E2 病灶）
    if (/^[一二三四五六七八九]{2,}$/.test(tok) && !/[十百]/.test(tok)) continue;
    const n = /^\d+$/.test(tok) ? Number(tok) : seqNumber(tok);
    if (!Number.isFinite(n)) continue;
    total += n * UNIT_G[unit];
    lastUnit = unit;
    hit = true;
  }
  // 「一两五钱」已按两段累加；「一斤半」的“半”没带单位，补在上一个单位上
  if (lastUnit && /半\s*$/.test(text)) {
    total += 0.5 * UNIT_G[lastUnit];
    hit = true;
  }
  return hit ? Math.round(total * 10) / 10 : null;
}

/* ── W6 约耗字段化（ITERATION-0.5 W6，E3#5 / E1）─────────────────────────
 * 原料行括号里的「约耗X」「实耗X」「（耗X）」是附着口径：整锅下锅、实际耗用 X。
 * 入库 grams 仍是整锅值（原文口径不变，tools/nutrition-check.mjs 回归表锚定 1000g）；
 * 约耗值记进新字段 consumedGrams，营养层（enrich.mjs）对油脂行改用它当基数。
 * 只认带数值的形态：耗少许／耗油极少（无数值）与 不耗油／无耗（否定）不记。
 */
const CONSUMED_PAREN = /[（(]([^（()）]*耗[^（()）]*)[）)]/;
const CONSUMED_TAIL = /[（(]((?:约|实)?耗[^（()）]{0,16})$/;   // OCR 吞掉闭括号的残形（安徽-050）
const CONSUMED_NUM = /\d|[零〇一二三四五六七八九十百两半]/;

/** 括号里的量 → 克。「半两／半斤」这类打头的「半」也要认（toGrams 只认「一斤半」的半尾巴）。 */
function consumedMassGrams(text) {
  let total = 0;
  let hit = false;
  let lastUnit = null;
  // 「两」是单位不是数字（与 W0 的 toGrams/parseAmount 同口径）：否则「一两五钱」会被吞成「一两五」+「钱」，
  // 丢掉两的 50g——256 道 583kcal/道的教训（verify-w58 检查 4）。
  const re = /([0-9]+(?:\.[0-9]+)?|半|[零〇一二三四五六七八九十百]+)\s*(千克|公斤|斤|两|钱|分|克)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const tok = m[1];
    const unit = m[2];
    if (/^[一二三四五六七八九]{2,}$/.test(tok) && !/[十百]/.test(tok)) continue;   // 「三四钱」区间
    const n = tok === "半" ? 0.5 : /^\d/.test(tok) ? Number(tok) : seqNumber(tok);
    if (!Number.isFinite(n)) continue;
    total += n * UNIT_G[unit];
    lastUnit = unit;
    hit = true;
  }
  if (lastUnit && /半\s*$/.test(text)) { total += 0.5 * UNIT_G[lastUnit]; hit = true; }
  return hit ? Math.round(total * 10) / 10 : null;
}

/** 括号约耗文本 → 克数。无数值/否定形态返回 null。 */
export function consumedGramsOf(text) {
  const s = String(text ?? "");
  const m = s.match(CONSUMED_PAREN) ?? s.match(CONSUMED_TAIL);
  if (!m) return null;
  const inner = m[1];
  if (/[不无未]/.test(inner)) return null;      // 不耗油／无耗／未耗
  if (!CONSUMED_NUM.test(inner)) return null;   // 耗少许／耗油极少
  const g = consumedMassGrams(inner);
  return g && g > 0 ? g : null;
}

/** 一行原料 → { raw, name, key, amount, grams }。拆分失败时 raw 仍然完整。 */
export function splitIngredient(raw) {
  const cleaned = raw
    .replace(/\$\s*\\textcircled\{[^}]*\}\s*\$/g, "")
    .replace(/\$[^$]*\$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s*/, "")
    .trim();

  // 老菜谱的引导符：··· / ... / · / 全角冒号
  const m = cleaned.match(/^(.*?)\s*(?:·+|\.{2,}|：|:)\s*(.*)$/);
  let name = cleaned;
  let amount = "";
  if (m && m[1]) {
    name = m[1];
    amount = m[2];
  } else {
    const s = cleaned.match(/^(.*?)\s+([0-9零〇一二三四五六七八九十百两半].*)$/);
    if (s) { name = s[1]; amount = s[2]; }
  }

  name = name
    .replace(/〔[^〕]*〕/g, "")
    .replace(/[（(]\s*注\s*[)）]/g, "")
    .replace(/[*＊]+\s*$/, "")   // OCR 的脚注星号
    .replace(/^[料、：:\s]+/, "")
    .trim();
  // 「猪油一斤」「花生油二斤」「子鸡一只（约重二斤）」：OCR 把小节名/菜名和质量粘在一起。
  // 质量段允许多段复合：「肉清汤一斤六两」「白糖四斤五两」——单段版会把「一斤」留在原料名里、
  // 只把末段「六两」当分量（E2 Q6 的 49 条断裂）；括号全角/半角都要认（E3：「鲜黄鱼一条(约重一斤三两)」半角形态抽取失败）
  if (!amount) {
    const NUMS = "[0-9零〇一二三四五六七八九十百两]";
    const MASS = "(?:斤|两|钱|分|克)";
    const PAREN = "(?:[（(][^）)]*[）)])?";
    const glued = name.match(new RegExp(`^(.+?)(${NUMS}+${MASS}(?:${NUMS}+${MASS})*(?:半)?${PAREN})$`))
      ?? name.match(new RegExp(`^(.+?)(${NUMS}+(?:只|条|个|根|棵|朵|块|对)${PAREN})$`));
    if (glued && glued[1]) {
      name = glued[1];
      amount = glued[2];
    }
  }

  const entry = lookup(name);
  const parsed = parseAmount(amount, entry);
  // W6：约耗只记在油料行。名字被 OCR 拖上省略号的（「芝麻油……」）词表挂不上、掉进「其他」，
  // 剥掉省略号再查一次词表；非油料的「约耗」（酱油/面粉/卤水等 25 行）不入字段，
  // 留在 data/work/ocr-noise.json 的 W6 影响面清单里，等 0.5.1 逐条裁决。
  const oilish = entry?.parent === "油脂"
    || (name && entry?.guessed ? lookup(name.replace(/[…·.．]+$/, ""))?.parent === "油脂" : false);
  const consumed = oilish ? consumedGramsOf(raw) : null;
  return {
    raw,
    name,
    key: entry?.id ?? name,
    canon: entry?.id ?? name,
    parent: entry?.parent ?? "其他",
    cat: entry?.cat ?? "其他",
    allergen: entry?.allergen ?? [],
    guessed: entry?.guessed ?? false,
    amount,
    grams: parsed.grams,
    count: parsed.count,
    qualifier: parsed.qualifier,
    ...(consumed != null ? { consumedGrams: consumed } : {}),
  };
}

const METHOD_WORDS = ["清蒸", "粉蒸", "干烧", "红烧", "清炖", "拔丝", "油炸", "软炸", "干炸", "爆炒", "小炒", "煸", "烧", "炒", "蒸", "炸", "炖", "焖", "烤", "爆", "熘", "烩", "煮", "拌", "腌", "熏", "冻", "煎", "烹", "汆", "涮", "卤", "酱", "炝", "糟", "醉", "焗", "扣", "酥", "贴", "塌", "瓤", "酿"];
const FLAVOR_WORDS = ["咸鲜", "糖醋", "麻辣", "香辣", "酸辣", "鱼香", "怪味", "椒麻", "五香", "香酥", "清香", "清鲜", "酸甜", "咸甜", "咖喱", "蒜香", "葱香", "酱香", "酒香", "糟香", "奶香", "甜", "麻", "辣"];

// 步骤里出现就算用了这个手法，但排除「烧开」「炸锅」「爆锅」这类假阳性
const STEP_METHODS = [
  ["炸", /炸(?!锅)/], ["烧", /烧(?!开|沸|热)/], ["爆", /爆(?!锅)/], ["煎", /煎/], ["蒸", /蒸/],
  ["炖", /炖/], ["焖", /焖/], ["烤", /烤/], ["炒", /炒/], ["拌", /拌/], ["腌", /腌/],
  ["卤", /卤/], ["糟", /糟/], ["熏", /熏/], ["醉", /醉/], ["汆", /汆/], ["涮", /涮/], ["焗", /焗/], ["烩", /烩/],
];

/** 口味由「用量」推，而不是由菜名猜：糖 30g 以上才算甜，醋 10g 以上才算酸。 */
const FLAVOR_HINTS = [
  ["辣", (ings) => sum(ings, ["辣椒", "干辣椒", "辣椒粉", "辣椒油", "豆瓣酱"]) >= 8],
  ["麻", (ings) => sum(ings, ["花椒", "花椒盐"]) >= 2],
  ["酸", (ings) => sum(ings, ["醋", "番茄酱"]) >= 12],
  ["甜", (ings) => sum(ings, ["白糖", "冰糖", "红糖", "饴糖", "蜂蜜"]) >= 25],
  ["酱香", (ings) => sum(ings, ["豆瓣酱", "豆酱", "甜面酱", "酱油"]) >= 25],
  ["咖喱", (ings) => sum(ings, ["咖喱粉"]) >= 3],
  ["蒜香", (ings) => sum(ings, ["大蒜"]) >= 10],
  ["葱香", (ings) => sum(ings, ["葱"]) >= 30],
  ["糟香", (ings) => sum(ings, ["香糟", "酒酿"]) >= 10],
  ["五香", (ings) => sum(ings, ["五香粉"]) >= 1],
];

function sum(ings, canons) {
  return (ings ?? []).reduce((s, i) => (canons.includes(i.canon) ? s + (i.grams ?? 0) : s), 0);
}

/**
 * 技法/口味。技法优先看菜名（最准），再看步骤里出现最多的手法；口味先看特点描述，再按用料用量补。
 * 全是派生字段，允许以后重算。
 */
export function deriveTags(title, features = "", steps = [], ingredients = []) {
  const methods = METHOD_WORDS.filter((w) => title.includes(w));
  const stepText = (steps ?? []).join(" ");
  const counted = STEP_METHODS
    .map(([name, re]) => [name, (stepText.match(new RegExp(re.source, "g")) ?? []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [name] of counted.slice(0, 2)) if (!methods.includes(name)) methods.push(name);

  const hay = `${title} ${features}`;
  const flavors = FLAVOR_WORDS.filter((w) => hay.includes(w));
  for (const [name, test] of FLAVOR_HINTS) {
    if (flavors.includes(name)) continue;
    try { if (test(ingredients)) flavors.push(name); } catch { /* 忽略 */ }
  }

  // 老菜谱几乎都有盐；没别的味型就落回「咸鲜」，这是有依据的默认值
  if (!flavors.length && sum(ingredients, ["盐"]) >= 1) flavors.push("咸鲜");
  return {
    methods: [...new Set(methods)].slice(0, 4),
    flavors: [...new Set(flavors)].slice(0, 4),
  };
}

/**
 * 从目录页取「序号 + 菜名 + 原书页码」。目录是这套书的免费校准表：
 * 既能补 OCR 漏掉的菜名，也能给出可引用的页码。
 */
export function parseToc(files) {
  const entries = [];
  for (const { text } of files) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !RE_TOC.test(line)) continue;
      const m = line.match(RE_RECIPE);
      if (!m) continue;
      const title = m[2]
        .replace(/[·.．]{2,}.*$/, "")
        .replace(/[（(]\s*\d+\s*[)）].*$/, "")
        .replace(/[·.\s]+$/, "")
        .trim();
      if (!title || title.length > 20) continue;
      const page = Number(line.match(/[（(]\s*(\d+)\s*[)）]\s*$/)?.[1] ?? 0);
      entries.push({ seq: m[1], title: title.replace(/\s+/g, ""), page });
    }
  }
  return entries;
}

/* ── W8 标题清洗（OCR 噪声，清单在 data/work/ocr-noise.json）──────────────────
 * 菜名行尾的脚注符（「黄浆*」「皱纱圆蹄[注]」）和粘进菜名的第二层序号（「一、O、茶香熏鸡」
 * →「O、茶香熏鸡」）都不是菜名的一部分。只剎这两类，其余一字不动。
 */
export function cleanTitle(s) {
  let t = String(s ?? "")
    .replace(/\$[^$]*\$/g, "")
    .replace(/[（(][^）)]*[）)]$/, "")
    .replace(/\s+/g, "");
  // 外层序号被 OCR 连写进菜名（广东-109「O、茶香熏鸡」）：剥掉后仍要有字才动
  const dup = t.match(/^([〇Oo0-9零一二三四五六七八九十百]{1,4})、(.+)$/);
  if (dup && dup[2].trim()) t = dup[2];
  return t
    .replace(/[*＊※]+/g, "")     // 脚注星号：行尾（黄浆*）和夹在中间（蟹粉*扒鸡腰）都有
    .replace(/[〔\[]注[〕\]]$/, "")
    .trim();
}

/**
 * W8：识别被 OCR 粘进制法段落里的「特点」节。
 * 「……即成。上桌时带姜米醋碟蘸食。特点」→ { atEnd: true }（特点正文在下一段）；
 * 「……便成。特点：此菜呈金黄色……」→ { feature: "此菜呈金黄色……" }。
 * 节头前必须是句末标点（或行首），正文同行时至少 12 字，避免误伤「保持了原料的特点」这类行文。
 */
export function gluedFeatureOf(line) {
  // 先剎掉 LaTeX 脚注残迹（「淮盐 $\textcircled{3}$特点；…」），节头常贴在脚注符后面
  const s = String(line ?? "")
    .replace(/\$\s*\\textcircled\{[^}]*\}\s*\$/g, "")
    .replace(/\$[^$]*\$/g, "");
  const hits = [...s.matchAll(/特\s*点/g)];
  for (let k = hits.length - 1; k >= 0; k--) {
    const i = hits[k].index;
    // 节头前允许隔着脚注符/空格/列表符，再往前必须是句末标点（或行首）；行文里的
    // 「这道菜的特点…」「体现了…特点」靠 的/是/其 这类前置字排除
    let j = i - 1;
    while (j >= 0 && /[\s$-]/.test(s[j])) j--;
    const prev = j < 0 ? "" : s[j];
    const punctBefore = j < 0 || /[。！？…”』」；;]/.test(prev);
    // 句末标点（或行首）直接算节头；汉字紧贴的（陕西册「颠翻装盘特点酥香爽口…」）
    // 只有不是「的特点/是特点」这类行文才算，正文成不成句交给下面的长度+标点检查
    if (!punctBefore && (!/[一-龥]/.test(prev) || /[的是其有了很]/.test(prev))) continue;
    const rest = s.slice(i + hits[k][0].length).replace(/^[：:；;、，]\s*/, "");
    if (!rest) return { feature: "", atEnd: true };
    // 同行特点正文：至少 8 字且带标点/句尾，避免把「特点」二字当普通词捞进来
    if (rest.length >= 8 && /[，。；、！？]/.test(rest)) return { feature: rest.trim(), atEnd: false };
  }
  return null;
}

/**
 * 解析一册。
 * @param {{book:string, cuisine:string, files:{file:string,text:string}[]}} input
 */
export function parseBook({ book, cuisine, files }) {
  const recipes = [];
  const orphanTitles = [];   // 标题丢了的菜（OCR 漏行），单独记出来
  let cur = null;
  let section = null;
  let chapter = "";
  let blankBefore = true;

  const start = (title, seq, file, pending = false) => {
    cur = {
      title,
      seq,
      chapter,
      pages: [file],
      ingredients: [],
      steps: [],
      features: [],
      notes: [],
      needsTitle: pending,
    };
    section = null;
    blankBefore = false;
  };

  const stop = () => {
    if (!cur) return;
    if (cur.ingredients.length || cur.steps.length) {
      // W8：「特点」段被 OCR 粘进制法末步（书里是独立小节，OCR 把节头和正文拼进了上一段）。
      // steps 一字不动，只把特点段补回 features 字段（检索与 recipe_get 的「特点」栏用这份）。
      if (!cur.features.length && cur.steps.length) {
        const glue = gluedFeatureOf(cur.steps[cur.steps.length - 1]);
        if (glue?.feature) cur.features.push(glue.feature.replace(/^[是为](?=.+)/, "").trim());
      }
      const features = cur.features.join(" ");
      const tags = deriveTags(cur.title, features, cur.steps, cur.ingredients);
      recipes.push({
        id: "",
        title: cur.title,
        seq: cur.seq,
        book,
        cuisine,
        chapter: cur.chapter,
        pages: cur.pages,
        ingredients: cur.ingredients,
        steps: cur.steps,
        features,
        notes: cur.notes,
        methods: tags.methods,
        flavors: tags.flavors,
        derived: true,
        ...(cur.needsTitle ? { needsTitle: true } : {}),
      });
    }
    cur = null;
    section = null;
  };

  for (const { file, text: pageText } of files) {
    // GLM-OCR 对双栏用料会输出 HTML 表格；先摊平成「鸡蛋 四只」这样的行
    const text = pageText.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
      const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
        [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
          .map((cell) => cell[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim())
          .filter(Boolean)
          .join(" "),
      );
      return `\n${rows.filter(Boolean).join("\n")}\n`;
    });

    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) { blankBefore = true; continue; }
      if (line.startsWith("![](") || line.startsWith("<div") || line.startsWith("</div") || line.startsWith("<table") || line.startsWith("*图") || /^图\s*\d/.test(line)) continue;
      if (line === "---") continue;

      // 「原料净桂鱼肉…四两」「原料猪肘肉一块」：小节名和内容挤在同一行
      const inline = line.match(/^#{0,4}\s*(原\s*料|制\s*法|做\s*法|特\s*点|附\s*注|注)\s*[：:]?\s*(.+)$/);
      const bare = BARE_SECTION[line.replace(/[#\s：:]/g, "")];
      const sec = inline ? [null, inline[1]] : line.match(RE_SECTION);
      if (sec || (bare && (!cur || bare !== "ingredients" || cur.ingredients.length === 0))) {
        const next = sec ? SECTION_MAP[sec[1].replace(/\s/g, "")] : bare;
        // 「原料」再次出现 = 上一道菜已结束，新菜的开始标题被 OCR 漏掉了
        if (next === "ingredients" && cur && cur.ingredients.length > 0) {
          stop();
          start("（标题缺失）", "", file, true);
        }
        section = next;
        blankBefore = false;
        if (!inline) continue;
        line = inline[2].trim();   // 同一行的内容继续按小节正文处理
        if (!line) continue;
      }

      const m = line.match(RE_RECIPE);
      if (m && !RE_TOC.test(line) && m[2].length <= 32) {
        stop();
        start(cleanTitle(m[2]), m[1], file);
        continue;
      }

      // 章节标题（肉菜类 / 水产菜类 / 冷盘 …），可能带序号或字间空格
      if (/^#{1,4}\s/.test(line)) {
        const t = line.replace(/^#+\s*/, "").replace(/^[一二三四五六七八九十百零〇\dOo]+\s*[、.．]\s*/, "").replace(/\s+/g, "").trim();
        if (t.length <= 8 && /(类|冷盘|拼盘)$/.test(t)) {
          stop();
          chapter = t;
          blankBefore = true;
          continue;
        }
      }

      if (!cur) continue;
      if (!cur.pages.includes(file)) cur.pages.push(file);

      if (section === "ingredients") {
        // 原料表中间冒出的 Markdown 残行（北京-184「## 1. 索火腿：」子方标题、安徽-005「# 374847」
        // 乱码页码、山东-040「## 制·法」被啃坏的小节名）：不是原料。带制法/做法的翻到做法节，
        // 其余丢弃（清单在 data/work/ocr-noise.json），原料行原文不受影响。
        if (/^#{1,6}\s/.test(line)) {
          if (/制\s*法|做\s*法/.test(line)) {
            section = "steps";
          }
          blankBefore = false;
          continue;
        }
        // 「原料」名和分量被 OCR 拆成了两行：把纯分量行接回上一条
        if (/^[（(]?约重|^[0-9零〇一二三四五六七八九十百两半]+(千克|公斤|斤|两|钱|分|克|只|条|个|根|棵|朵|块|对)/.test(line) && cur.ingredients.length) {
          const prev = cur.ingredients[cur.ingredients.length - 1];
          if (!prev.amount) {
            const p = parseAmount(line, lookup(prev.name));
            prev.amount = line;
            prev.grams = p.grams;
            prev.count = p.count;
            prev.qualifier = p.qualifier;
            blankBefore = false;
            continue;
          }
        }
        // 原料表中间的脚注行（「* 酱麻油制法：…」上海-152）：挪到附注但不翻小节——
        // 一翻原料节就断了，后面的白芝麻/鸡蛋清等全部丢失，整道菜 kcal=0（E3 #4）
        if (/^[*＊※]/.test(line) && /制法|做法/.test(line)) {
          cur.notes.push(`〔注〕${line}`);
          blankBefore = false;
          continue;
        }
        // 正文里嵌的配菜/半成品做法（如「荷叶夹制法」）不属于主料，移到附注，避免污染用料表
        // 但原料行里的「（制法见“红烧大群翅”）」是交叉引用，不是嵌入做法——不能翻小节
        if (/制法|做法/.test(line) && line.length > 8 && !CROSS_REF.test(line)) {
          section = "notes";
          cur.notes.push(`〔附〕${line}`);
          blankBefore = false;
          continue;
        }
        // 「姜片 二钱法」：做法标题的最后一个字被 OCR 粘在原料行尾
        const gluedSection = line.match(/^(.*(?:钱|两|斤|克|分|只|条|个))\s*法$/);
        if (gluedSection) {
          cur.ingredients.push(splitIngredient(gluedSection[1]));
          section = "steps";
          blankBefore = false;
          continue;
        }
        const ing = splitIngredient(line);
        // OCR 常把「原料」拦腰截断成单独一个「料」字，这类残字不进用料表
        if (!ing.name || (ing.name.length === 1 && "料原注，。、".includes(ing.name))) {
          blankBefore = false;
          continue;
        }
        // 无引导符、无剂量、且很短：大概率是上一行续行
        if (!/[·．]|\.{2,}/.test(line) && !ing.amount && line.length <= 8 && cur.ingredients.length) {
          cur.ingredients[cur.ingredients.length - 1].raw += line;
        } else {
          cur.ingredients.push(ing);
        }
      } else if (section === "steps") {
        const numbered = line.match(/^(?:\(\d+\)|（\d+）|\d+[.．、])\s*(.*)$/);
        const body = numbered ? numbered[1] : line;
        const prev = cur.steps[cur.steps.length - 1];
        const continues = !numbered && prev && !SENTENCE_END.test(prev) && !blankBefore;
        if (continues) cur.steps[cur.steps.length - 1] = prev + body;
        else if (!numbered && prev && !SENTENCE_END.test(prev)) cur.steps[cur.steps.length - 1] = prev + body; // 跨页续行（页首补行）
        else cur.steps.push(body);
      } else if (section === "features") {
        const last = cur.features[cur.features.length - 1];
        if (last && !SENTENCE_END.test(last) && !blankBefore) cur.features[cur.features.length - 1] = last + line;
        else cur.features.push(line);
      } else if (section === "notes") {
        cur.notes.push(line);
      } else if (/^[（(〔].*注|注[:：]/.test(line)) {
        cur.notes.push(line);
      }
      blankBefore = false;
    }
    blankBefore = true; // 页边界当作分段
  }
  stop();

  // 用目录补 OCR 漏掉的菜名，并顺手拿到原书页码
  const toc = parseToc(files);
  const norm = (s) => s.replace(/\s+/g, "");
  let k = 0;
  for (const r of recipes) {
    if (!r.needsTitle) {
      let j = k;
      while (j < Math.min(toc.length, k + 4) && norm(toc[j].title) !== norm(r.title)) j++;
      if (j < toc.length && norm(toc[j].title) === norm(r.title)) {
        k = j + 1;
        if (!r.page) r.page = toc[j].page;
      }
      continue;
    }
    if (k < toc.length) {
      r.title = toc[k].title;
      r.page = toc[k].page;
      r.needsTitle = false;
      r.recoveredTitle = true;
      k++;
    }
  }

  const stillMissing = recipes.filter((r) => r.needsTitle);
  const prefix = (cuisine.match(/[\u4e00-\u9fa5]{1,2}/) ?? ["食"])[0];
  return {
    recipes: recipes.map((r, i) => ({ ...r, id: `${prefix}-${String(i + 1).padStart(3, "0")}` })),
    orphanTitles: stillMissing.map((r) => ({ pages: r.pages, seq: r.seq })),
    tocCount: toc.length,
  };
}
