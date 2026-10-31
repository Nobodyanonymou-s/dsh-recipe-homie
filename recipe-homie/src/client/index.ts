/**
 * Browser half. Normal ES TypeScript module: tsdown compiles it (format cjs,
 * platform browser, react left external) and re-wraps the body into the
 * classic-script shape DSH requires — `window.__ModuleLoader__.load({ id,
 * factory: (require) => ... })` with a module/exports shim. React therefore
 * stays a runtime `require("react")` resolved by the host shell; nothing else
 * from node_modules is imported.
 *
 * Seven keyed tool views plus the right-sidebar tab. Each view reads only the
 * persisted result metadata that the host's `output.presentationMeta` produced
 * — no fetch, no parsing of the model-visible text. Malformed or missing
 * metadata renders a generic row, so a replay from an older session never
 * breaks. The presentationMeta card shapes are a frozen contract.
 */
import React from "react";

/** createElement is kept loose on purpose: props are untyped host data. */
const h: (...args: any[]) => any = React.createElement;

const T = {
  zh: {
    ingredients: "用料",
    steps: "做法",
    notes: "附注",
    minutes: "分钟",
    servings: "人份",
    protein: "蛋白",
    kcal: "kcal",
    perPerson: "/人",
    source: "出处",
    variants: "其他版本",
    allergens: "注意",
    matched: "命中",
    blocked: "道按忌口过滤",
    shopping: "采购清单",
    buyOnce: "一次买够",
    pantry: "常备调料",
    selfMade: "自家熬",
    keep: "蛋奶/豆制品",
    menu: "菜单",
    shuffleHint: "再摇一次",
    fallback: "或者不做",
    want: "你念叨过",
    recent: "天前做过",
    generic: "结果",
    empty: "没有可显示的结构化结果，展开原始输出。",
    day: "第",
    dayEnd: "天",
    pick: "挑一道",
    kinds: "样主辅料",
    veg: "素",
    pin: "钉到侧栏",
    boardEmptyTitle: "这桌还是空的",
    boardEmpty: "先去对话里摇一桌，或者取一道菜的详情——这里会跟着显示本会话最近出过的卡。",
    boardRecipes: "最近取的菜",
    boardHint: "摇一桌",
  },
  en: {
    ingredients: "Ingredients",
    steps: "Method",
    notes: "Notes",
    minutes: "min",
    servings: "servings",
    protein: "protein",
    kcal: "kcal",
    perPerson: "/person",
    source: "Source",
    variants: "Other versions",
    allergens: "Careful",
    matched: "matched",
    blocked: "filtered by your restrictions",
    shopping: "Shopping list",
    buyOnce: "Buy once",
    pantry: "Pantry",
    selfMade: "Make at home",
    keep: "Dairy / tofu",
    menu: "Menu",
    shuffleHint: "Reroll",
    fallback: "or skip cooking",
    want: "you asked for this",
    recent: "days ago",
    generic: "Result",
    empty: "No structured result; expand the raw output.",
    day: "Day ",
    dayEnd: "",
    pick: "Pick one",
    kinds: " kinds",
    veg: "veg",
    pin: "Pin to sidebar",
    boardEmptyTitle: "Nothing pinned yet",
    boardEmpty: "Draw a table or open a recipe in the conversation — the cards you get will show up here.",
    boardRecipes: "Recent recipes",
    boardHint: "Table",
  },
};

/** 中英文案同形：键集合一致，值都是字符串。 */
type Strings = (typeof T)["zh"];

/** 一条结果卡的 presentationMeta。字段完全由宿主产出，这里只做防御性读取。 */
type Meta = Record<string, any>;

/** 右侧栏「这桌」页签从会话日志派生出的只读快照。 */
type BoardState = { board: Meta | null; shuffle: Meta | null; recipes: Meta[] };

const C = {
  card: { border: "0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.28))", borderRadius: "var(--dsw-radius-md, 12px)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))" },
  head: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
  title: { fontSize: "15px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
  sub: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))" },
  caption: { fontSize: "12px", color: "var(--dsw-alias-label-caption, rgba(127,127,127,0.8))" },
  chips: { display: "flex", gap: "6px", flexWrap: "wrap" },
  chip: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", border: "0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.28))", color: "var(--dsw-alias-label-secondary, inherit)" },
  warn: { fontSize: "11px", padding: "1px 7px", borderRadius: "999px", color: "#b54708", border: "0.5px solid #f79009" },
  section: { display: "flex", flexDirection: "column", gap: "6px" },
  label: { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, inherit)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "2px 14px", fontSize: "13px" },
  ing: { display: "flex", justifyContent: "space-between", gap: "8px", borderBottom: "0.5px dotted var(--dsw-alias-border-l3, rgba(127,127,127,0.22))", padding: "2px 0" },
  grams: { color: "var(--dsw-alias-label-caption, rgba(127,127,127,0.8))", fontSize: "12px" },
  ol: { margin: 0, paddingLeft: "18px", fontSize: "13px", lineHeight: 1.7 },
  prose: { margin: 0, fontSize: "13px", lineHeight: 1.7, color: "var(--dsw-alias-label-secondary, inherit)" },
  row: { display: "flex", gap: "10px", alignItems: "baseline", padding: "5px 0", borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.18))" },
  role: { fontSize: "11px", minWidth: "28px", color: "var(--dsw-alias-label-caption, rgba(127,127,127,0.8))" },
  day: { fontSize: "13px", fontWeight: 600, marginTop: "4px" },
  meal: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, inherit)" },
  dish: { fontSize: "13px", lineHeight: 1.6 },
  details: { fontSize: "13px" },
  summary: { cursor: "pointer", fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, inherit)" },
  pin: { fontSize: "11px", padding: "1px 8px", borderRadius: "999px", border: "0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.28))", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", cursor: "pointer", font: "inherit" },
  board: { display: "flex", flexDirection: "column", gap: "10px", padding: "10px 12px", overflowY: "auto", height: "100%" },
};

function lang(props: any): Strings {
  const l = props && props.locale ? String(props.locale) : "";
  return l.toLowerCase().startsWith("en") ? T.en : T.zh;
}

/** Result metadata is the only input; anything else is a generic row. */
function cardOf(props: any): Meta | null {
  const block = props && props.block;
  if (!block || props.phase !== "result") return null;
  const meta = block.meta;
  return meta && typeof meta === "object" && typeof meta.kind === "string" ? meta : null;
}

/** Text a card can show when the host gave it nothing structured. */
function rawText(block: any): string {
  const content = block && block.content;
  if (!Array.isArray(content)) return "";
  return content.map((item: any) => (item && item.type === "text" ? item.text : "")).filter(Boolean).join("\n");
}

export function Generic(props: any) {
  const t = lang(props);
  const block = props.block;
  const text = rawText(block) || (t.empty);
  return h("div", { style: C.card },
    h("div", { style: C.head },
      h("span", { style: C.title }, props.toolName || t.generic),
      h("span", { style: C.sub }, props.phase === "result" ? "" : "…")),
    h("pre", { style: { ...C.prose, whiteSpace: "pre-wrap", margin: 0 } }, text));
}

function Chip({ text, warn }: { text: any; warn?: any }) {
  return h("span", { style: warn ? C.warn : C.chip }, text);
}

function Ingredients({ items, t }: { items: any; t: Strings }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return h("section", { style: C.section },
    h("div", { style: C.label }, t.ingredients),
    h("div", { style: C.grid },
      items.map((i: any, n: number) => h("div", { key: n, style: C.ing },
        h("span", null, i.name),
        h("span", { style: C.grams }, [i.amount, i.grams ? `${i.grams}g` : ""].filter(Boolean).join(" · "))))));
}

function Steps({ items, t }: { items: any; t: Strings }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return h("section", { style: C.section },
    h("div", { style: C.label }, t.steps),
    h("ol", { style: C.ol }, items.map((s: any, n: number) => h("li", { key: n }, s))));
}

function PinButton({ onPin, t }: { onPin: any; t: Strings }) {
  return h("button", { type: "button", style: C.pin, onClick: () => { try { onPin(); } catch {} } }, t.pin);
}

/** recipe_get */
export function RecipeCard(props: any) {
  const meta = cardOf(props);
  if (!meta || meta.kind !== "recipe" || typeof meta.title !== "string" || !Array.isArray(meta.ingredients)) return h(Generic, props);
  const t = lang(props);
  return h("article", { style: C.card, "data-tool": "recipe_get" },
    h("div", { style: C.head },
      h("span", { style: C.title }, meta.title),
      h("span", { style: C.sub }, [meta.cuisine, meta.chapter].filter(Boolean).join(" · ")),
      typeof props.onPin === "function" ? h(PinButton, { onPin: props.onPin, t }) : null),
    h("div", { style: C.chips },
      meta.minutes ? h(Chip, { text: `${meta.minutes} ${t.minutes}` }) : null,
      meta.servings ? h(Chip, { text: `${meta.servings} ${t.servings}` }) : null,
      meta.protein ? h(Chip, { text: `${t.protein} ${meta.protein}g${t.perPerson}` }) : null,
      meta.kcal ? h(Chip, { text: `${meta.kcal} ${t.kcal}` }) : null,
      meta.page ? h(Chip, { text: `${t.source} p.${meta.page}` }) : null,
      (meta.allergens || []).map((a: any, n: number) => h(Chip, { key: n, text: a, warn: true }))),
    h(Ingredients, { items: meta.ingredients, t }),
    h(Steps, { items: meta.steps, t }),
    meta.features ? h("p", { style: C.prose }, meta.features) : null,
    (meta.notes || []).length ? h("p", { style: C.caption }, meta.notes.join(" · ")) : null,
    (meta.variants || []).length ? h("div", { style: C.caption }, `${t.variants}：${meta.variants.join("、")}`) : null);
}

/** recipe_search */
export function SearchCard(props: any) {
  const meta = cardOf(props);
  if (!meta || meta.kind !== "search" || !Array.isArray(meta.items)) return h(Generic, props);
  const t = lang(props);
  const head = `${t.matched} ${meta.total}${meta.blocked ? ` · ${meta.blocked} ${t.blocked}` : ""}`;
  return h("div", { style: C.card, "data-tool": "recipe_search" },
    h("div", { style: C.caption }, head),
    (meta.items || []).map((r: any, n: number) => h("div", { key: n, style: C.row },
      h("span", { style: C.role }, r.skill === "easy" ? "易" : r.skill === "hard" ? "难" : "练"),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "1px", flex: 1 } },
        h("span", { style: C.dish }, r.title),
        h("span", { style: C.caption }, [r.cuisine, r.chapter, r.minutes ? `${r.minutes}${t.minutes}` : "", r.protein ? `${r.protein}g` : ""].filter(Boolean).join(" · ")),
        r.features ? h("span", { style: C.caption }, r.features) : null))));
}

/** plan_week */
function MenuDay({ d, t }: { d: any; t: Strings }) {
  const meals = (d.meals || []).map((m: any, i: number) => {
    const dishes = (m.dishes || []).map((x: any) => {
      const badge = [x.minutes ? `${x.minutes}${t.minutes}` : "", x.want ? t.want : "", x.recent != null ? `${x.recent}${t.recent}` : ""].filter(Boolean).join(" · ");
      const notes = (x.note || []).map((note: any, k: number) => h("div", { key: k, style: C.caption }, `↳ ${note}`));
      return h("div", { key: x.id, style: C.dish }, `· ${x.title}`, badge ? h("span", { style: C.caption }, `  ${badge}`) : null, notes);
    });
    return h("div", { key: i },
      h("div", { style: C.meal }, `${m.name} · ${t.protein} ${m.protein}g${t.perPerson} · ${m.kcal}${t.kcal}`),
      dishes);
  });
  return h("div", null, h("div", { style: C.day }, `${t.day}${d.day}${t.dayEnd}`), meals);
}

function ShopBlock({ title, items, t }: { title: any; items: any; t: Strings }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return h("div", null,
    h("div", { style: C.label }, title),
    items.map((i: any, n: number) => h("div", { key: n, style: C.ing }, h("span", null, i.name), h("span", { style: C.grams }, i.qty))));
}

export function PlanCard(props: any) {
  const meta = cardOf(props);
  if (!meta || meta.kind !== "plan" || !Array.isArray(meta.menu)) return h(Generic, props);
  const t = lang(props);
  const s = meta.shopping || {};
  const head = h("div", { style: C.head },
    h("span", { style: C.title }, `${meta.days} ${t.dayEnd || "天"} · ${meta.people} ${t.servings}`),
    h("span", { style: C.sub }, meta.energy === "tired" ? "省事模式" : meta.energy === "good" ? "有精力" : ""));
  const days = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
    (meta.menu || []).map((d: any) => h(MenuDay, { key: d.day, d, t })));
  const batches = (s.batches || []).map((b: any, i: number) => h(ShopBlock, { key: i, title: b.label, items: b.items, t }));
  const details = h("details", { style: C.details },
    h("summary", { style: C.summary }, `${t.shopping} · ${(s.buyOnce || []).length} ${t.buyOnce}`),
    h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" } },
      h(ShopBlock, { title: t.buyOnce, items: s.buyOnce, t }),
      batches,
      h(ShopBlock, { title: t.pantry, items: s.staples, t }),
      h(ShopBlock, { title: t.selfMade, items: s.selfMade, t }),
      h(ShopBlock, { title: t.keep, items: s.keep, t })));
  const notes = h("div", { style: C.caption }, (meta.notes || []).map((n: any, i: number) => h("div", { key: i }, n)));
  return h("div", { style: C.card, "data-tool": "plan_week" }, head, days, details, notes);
}

/** menu_shuffle */
export function ShuffleCard(props: any) {
  const meta = cardOf(props);
  if (!meta || meta.kind !== "shuffle" || !Array.isArray(meta.dishes)) return h(Generic, props);
  const t = lang(props);
  return h("div", { style: C.card, "data-tool": "menu_shuffle" },
    h("div", { style: C.head },
      h("span", { style: C.title }, `${meta.people} ${t.servings} · ${meta.combo}`),
      h("span", { style: C.sub }, `${t.shuffleHint} ${meta.rerollCount}`),
      typeof props.onPin === "function" ? h(PinButton, { onPin: props.onPin, t }) : null),
    (meta.dishes || []).map((d: any) => h("div", { key: d.id, style: C.dish },
      `· ${d.title}`,
      h("span", { style: C.caption }, [d.cuisine, d.minutes ? `${d.minutes}${t.minutes}` : "", d.protein ? `${d.protein}g${t.perPerson}` : "", d.want ? t.want : ""].filter(Boolean).join(" · ")),
      d.story ? h("div", { style: C.caption }, d.story) : null,
      (d.note || []).map((note: any, k: number) => h("div", { key: k, style: C.caption }, `↳ ${note}`)))),
    meta.askReason ? h("div", { style: { ...C.caption, color: "#b54708" } }, meta.hint) : h("div", { style: C.caption }, meta.hint));
}

/** recommend */
function RecommendCard(props: any) {
  const meta = cardOf(props);
  if (!meta || meta.kind !== "recommend" || !Array.isArray(meta.items)) return h(Generic, props);
  const t = lang(props);
  const sceneTxt = meta.scene === "hungry" ? "饿的晚上" : meta.scene === "learn" ? "学菜的晚上" : "日常晚饭";
  return h("div", { style: C.card, "data-tool": "recommend" },
    h("div", { style: C.head },
      h("span", { style: C.title }, `${sceneTxt} · ${t.pick}`),
      h("span", { style: C.sub }, `${meta.people} ${t.servings}${meta.occasion === "banquet" ? " · 宴请" : ""}`)),
    (meta.items || []).map((d: any) => h("div", { key: d.id, style: C.row },
      h("span", { style: C.role }, d.skill === "easy" ? "易" : d.skill === "hard" ? "难" : d.skill === "learn" ? "练" : ""),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "1px", flex: 1 } },
        h("span", { style: C.dish }, d.title, d.isProtein ? null : `（${t.veg ?? "素"}）`),
        h("span", { style: C.caption }, [d.cuisine, d.chapter, d.minutes ? `${d.minutes}${t.minutes}` : "", d.variety ? `${d.variety}${t.kinds}` : "", d.protein ? `${t.protein} ${Math.round(d.protein)}g${t.perPerson}` : ""].filter(Boolean).join(" · ")),
        d.why ? h("span", { style: C.caption }, d.why) : null,
        (d.note || []).map((n: any, k: number) => h("div", { key: k, style: C.caption }, `↳ ${n}`))))),
    h("div", { style: C.caption }, meta.hint));
}

/** cook_rescue */
export function RescueCard(props: any) {
  const meta = cardOf(props);
  if (!meta || meta.kind !== "rescue" || !Array.isArray(meta.dishes)) return h(Generic, props);
  const t = lang(props);
  return h("div", { style: C.card, "data-tool": "cook_rescue" },
    h("div", { style: C.caption }, meta.fallback ? t.fallback : ""),
    (meta.dishes || []).map((d: any, i: number) => h("div", { key: i, style: C.dish }, `· ${d}`)),
    h("div", { style: C.caption }, meta.fallback || ""));
}

// ───────── 右侧栏「这桌」页签 ─────────
// 页签内容不单独存：全部从会话日志里派生（tool/result 事件上的 presentationMeta），
// 所以刷新、重开、换设备后页签照样有东西，也不用客户端存储。

/** 本会话出过的卡：最新一张「这桌」板书、最后一次摇桌、最近取过的菜谱详情。 */
export function boardFromWindow(entries: any): BoardState {
  let shuffle: Meta | null = null;
  let board: Meta | null = null;
  const recipes: Meta[] = [];
  const seen = new Set<string>();
  for (const entry of entries || []) {
    if (!entry || entry.type !== "event") continue;
    const ev = entry.event;
    if (!ev || ev.type !== "tool/result") continue;
    const meta = ev.data && ev.data.meta;
    if (!meta || typeof meta.kind !== "string") continue;
    if (meta.kind === "board" && Array.isArray(meta.dishes)) board = meta;
    else if (meta.kind === "shuffle" && Array.isArray(meta.dishes)) shuffle = meta;
    else if (meta.kind === "recipe" && typeof meta.id === "string" && !seen.has(meta.id)) {
      seen.add(meta.id);
      recipes.push(meta);
    }
  }
  return { board, shuffle, recipes: recipes.slice(-4).reverse() };
}

const EMPTY_BOARD: BoardState = { board: null, shuffle: null, recipes: [] };

/** 只读快照源：没人订阅就不挂事件流，内容没变就不通知。 */
export function createBoardStore(source: any) {
  let snapshot: BoardState | null = null;
  let digest = "";
  const listeners = new Set<() => void>();
  let off: (() => void) | undefined;
  const compute = (): boolean => {
    try {
      const next = boardFromWindow(source.getSnapshot().entries);
      const key = JSON.stringify(next);
      if (key === digest) return false;
      digest = key;
      snapshot = next;
      return true;
    } catch {
      return false;
    }
  };
  const getSnapshot = (): BoardState => {
    if (snapshot === null) compute();
    return snapshot || EMPTY_BOARD;
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      compute();
      try {
        off = source.subscribe(() => {
          if (!compute()) return;
          for (const fn of [...listeners]) {
            try { fn(); } catch {}
          }
        });
      } catch {
        off = undefined;
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0 || !off) return;
      try { off(); } catch {}
      off = undefined;
    };
  };
  return { getSnapshot, subscribe };
}

/** 页签里的一张菜卡：和对话里的 recipe 卡同款版式，但独立于工具调用存在。 */
export function BoardDish({ meta, t }: { meta: Meta; t: Strings }) {
  const chips = [
    meta.minutes ? `${meta.minutes} ${t.minutes}` : "",
    meta.servings ? `${meta.servings} ${t.servings}` : "",
    meta.protein ? `${t.protein} ${meta.protein}g${t.perPerson}` : "",
    meta.kcal ? `${meta.kcal} ${t.kcal}` : "",
    meta.page ? `${t.source} p.${meta.page}` : "",
  ].filter(Boolean);
  return h("article", { style: C.card, "data-board-dish": meta.id },
    h("div", { style: C.head },
      h("span", { style: C.title }, meta.title),
      h("span", { style: C.sub }, [meta.cuisine, meta.chapter].filter(Boolean).join(" · "))),
    chips.length ? h("div", { style: C.chips }, chips.map((c: any, n: number) => h(Chip, { key: n, text: c }))) : null,
    h(Ingredients, { items: meta.ingredients, t }),
    h(Steps, { items: meta.steps, t }),
    meta.features ? h("p", { style: C.prose }, meta.features) : null,
    (meta.notes || []).length ? h("p", { style: C.caption }, meta.notes.join(" · ")) : null);
}

/** 一张「这桌」板书：标题 + 菜卡 + 采购 + 提醒。对话里的 show_card 和侧栏页签共用。 */
function BoardView({ meta, t, onPin }: { meta: Meta; t: Strings; onPin: any }) {
  const dishes = Array.isArray(meta.dishes) ? meta.dishes : [];
  const shopping = Array.isArray(meta.shopping) ? meta.shopping : [];
  const groups: string[] = [];
  const byGroup = new Map<string, any>();
  for (const s of shopping) {
    const g = s.group || t.shopping;
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      groups.push(g);
    }
    byGroup.get(g).push(s);
  }
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    h("div", { style: C.card, "data-tool": "show_card" },
      h("div", { style: C.head },
        h("span", { style: C.title }, meta.title || t.boardRecipes),
        h("span", { style: C.sub }, `${dishes.length} 道菜${shopping.length ? ` · ${shopping.length} 项采购` : ""}`),
        typeof onPin === "function" ? h(PinButton, { onPin, t }) : null)),
    dishes.map((d: any) => h(BoardDish, { key: d.id || d.title, meta: d, t })),
    groups.length
      ? h("div", { style: C.card },
          h("div", { style: C.label }, t.shopping),
          groups.map((g: string) => h("section", { key: g, style: C.section },
            h("div", { style: C.caption }, g),
            byGroup.get(g).map((s: any, n: number) => h("label", { key: n, style: { ...C.ing, cursor: "pointer" } },
              h("span", null,
                h("input", { type: "checkbox", style: { marginRight: "6px" } }),
                `${s.name}${s.qty ? `  ${s.qty}` : ""}`),
              s.note ? h("span", { style: C.grams }, s.note) : null)))))
      : null,
    (meta.notes || []).length
      ? h("div", { style: C.card },
          h("ul", { style: { ...C.prose, margin: 0, paddingLeft: "18px" } },
            meta.notes.map((n: any, i: number) => h("li", { key: i }, n))))
      : null);
}

// ───────── 板书自动弹侧栏 ─────────
// 新生成的板书卡出现时自动打开「这桌」页签；同一张卡（callId）只弹一次，
// 用 localStorage 记住，刷新/重开、翻历史都不会反复弹。
const AUTO_KEY = "dsh-recipe-homie:board-auto-opened";
const autoOpened = new Set<string>();
function boardAlreadyAutoOpened(callId: string | undefined): boolean {
  if (!callId || autoOpened.has(callId)) return true;
  try {
    const raw = window.localStorage.getItem(AUTO_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list) && list.includes(callId)) return true;
  } catch {}
  return false;
}
function rememberBoardAutoOpen(callId: string): void {
  autoOpened.add(callId);
  try {
    const raw = window.localStorage.getItem(AUTO_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = [...new Set([...Array.isArray(list) ? list : [], callId])].slice(-50);
    window.localStorage.setItem(AUTO_KEY, JSON.stringify(next));
  } catch {}
}

/** show_card 的 toolview：同一张板书，带上「钉到侧栏」；新卡还会自动把侧栏弹出来。 */
function ShowCardView(props: any) {
  const meta = cardOf(props);
  const effect = React.useEffect;
  if (typeof effect === "function") {
    effect(() => {
      if (props.phase !== "result") return;
      const m = cardOf(props);
      if (!m || m.kind !== "board") return;
      if (typeof props.onAutoOpen === "function") props.onAutoOpen();
    }, [props.phase, props.callId]);
  }
  if (!meta || meta.kind !== "board") return h(Generic, props);
  const t = lang(props);
  return h(BoardView, { meta, t, onPin: props.onPin });
}

/** 右侧栏「这桌」页签主体。 */
export function BoardTab(props: any) {
  const t = lang(props);
  const store = props.store || { getSnapshot: () => EMPTY_BOARD, subscribe: () => () => {} };
  const snapshot = React.useSyncExternalStore
    ? React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    : store.getSnapshot();
  if (snapshot.board) return h("div", { style: C.board }, h(BoardView, { meta: snapshot.board, t }));
  const shuffle = snapshot.shuffle;
  const recipes = snapshot.recipes || [];
  if (!shuffle && recipes.length === 0) {
    return h("div", { style: { ...C.board, justifyContent: "center" } },
      h("div", { style: C.title }, t.boardEmptyTitle),
      h("p", { style: C.prose }, t.boardEmpty));
  }
  const head = shuffle
    ? h("div", { style: C.head },
        h("span", { style: C.title }, `${shuffle.people ?? ""} ${t.servings} · ${shuffle.combo ?? ""}`),
        h("span", { style: C.sub }, `${t.boardHint} ${shuffle.rerollCount ?? 0}`))
    : h("div", { style: C.head }, h("span", { style: C.title }, t.boardRecipes));
  const brief = shuffle && Array.isArray(shuffle.dishes) && recipes.length === 0
    ? shuffle.dishes.map((d: any) => h("div", { key: d.id || d.title, style: C.dish }, `· ${d.title}`,
        h("span", { style: C.caption }, [d.cuisine, d.minutes ? `${d.minutes}${t.minutes}` : "", d.protein ? `${d.protein}g${t.perPerson}` : ""].filter(Boolean).join(" · "))))
    : null;
  return h("div", { style: C.board },
    head,
    brief ? h("div", { style: C.section }, brief) : null,
    recipes.map((r: any) => h(BoardDish, { key: r.id, meta: r, t })));
}

const BOARD_TAB_ID = "dsh-recipe-homie-board";
const BOARD_KIND = "recipe-homie-board";

const VIEWS: Array<[string, (props: any) => any]> = [
  ["recipe_get", RecipeCard],
  ["recipe_search", SearchCard],
  ["plan_week", PlanCard],
  ["menu_shuffle", ShuffleCard],
  ["recommend", RecommendCard],
  ["cook_rescue", RescueCard],
  ["show_card", ShowCardView],
];

// 右侧栏服务不是可选的：没就绪就等（cordis 的 inject 会挂起），
// 否则 apply 先跑时 get 拿到 undefined，页签静默注册不上。
export const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

export function apply(ctx: any): void {
  const service = (name: string): any => {
    try {
      return ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  const openBoard = () => {
    const sidebar = service("sidebarRight");
    if (sidebar && typeof sidebar.openTab === "function") sidebar.openTab(BOARD_KIND);
  };
  /** 新板书出现时弹一次；同一张卡只弹一次（翻历史、刷新都不重复）。 */
  const autoOpenBoard = (callId: string) => {
    if (!callId || boardAlreadyAutoOpened(callId)) return;
    rememberBoardAutoOpen(callId);
    openBoard();
  };
  // 页签类型：宿主组态没带右侧栏时跳过，不影响对话里的卡。
  const tabTypes = service("sidebarRightTabs");
  if (tabTypes && typeof tabTypes.register === "function") {
    ctx.effect(
      () => tabTypes.register({ id: BOARD_TAB_ID, kind: BOARD_KIND, title: () => "这桌" }),
      "recipe-homie:board-tab",
    );
  }
  ctx.effect(
    () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
      name: "sidebar.right.pane.tab",
      key: BOARD_TAB_ID,
      inject: (sessionId: any) => {
        const sessions = service("sessions");
        let source: any;
        try {
          source = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId).eventSource : undefined;
        } catch {
          source = undefined;
        }
        return {
          store: source
            ? createBoardStore(source)
            : { getSnapshot: () => EMPTY_BOARD, subscribe: () => () => {} },
        };
      },
    }, BoardTab)),
    "recipe-homie:board-view",
  );
  for (const [key, View] of VIEWS) {
    const Pinned = (props: any) => h(View, {
      ...props,
      onPin: openBoard,
      onAutoOpen: key === "show_card" ? () => autoOpenBoard(props.callId) : undefined,
    });
    ctx.effect(
      () => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key }, Pinned)),
      `recipe-homie:toolview:${key}`,
    );
  }
}
