/**
 * 客户端卡片测试：不开浏览器，用假 React + 假 ModuleLoader 跑一遍。
 * 验证目标：
 *   1. 五个 toolview 都注册、每张卡能渲染、meta 损坏时回退成 generic；
 *   2. 右侧栏「这桌」页签：类型注册、主体注册、从会话日志派生内容、空状态；
 *   3. 卡片上的「钉到侧栏」按下后真的打开这个页签。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 最小 React：createElement 直接展开函数组件，只产树、不渲染。
// useSyncExternalStore 直接读一次快照（本测试不测订阅时序）；useEffect 立即执行一次。
const React = {
  createElement(tag, props, ...children) {
    const kids = children.flat(Infinity).filter((c) => c != null && c !== false);
    if (typeof tag === "function") return tag({ ...(props ?? {}), children: kids });
    return { tag, props: props ?? {}, children: kids };
  },
  Fragment: "Fragment",
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  useEffect(fn) { fn(); },
};

// ── 假宿主：slots + 右侧栏服务 + 会话事件流 ──
let events = [];
const fakeEventSource = {
  getSnapshot: () => ({ entries: events, hasMore: false, revision: 0, change: { kind: "replace", entries: [] } }),
  subscribe: () => () => {},
};
const tabDefs = [];
const opened = [];
const services = {
  sidebarRightTabs: { register(def) { tabDefs.push(def); return () => {}; } },
  sidebarRight: { openTab(kind) { opened.push(kind); } },
  sessions: { binding() { return { eventSource: fakeEventSource }; } },
};

const registered = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    return () => (typeof dispose === "function" ? dispose() : undefined);
  },
  get(name) { return services[name]; },
  slots: {
    inject(_name, fn) { return fn(); },
    register(spec, component) {
      registered.push({ name: spec.name, key: spec.key, inject: spec.inject, component });
      return () => {};
    },
  },
};

let factory = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) { factory = entry.factory; },
    },
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(`${ROOT}/lib/client.js`, "utf8"), sandbox, { filename: "client.js" });
if (!factory) throw new Error("client bundle 没有调用 __ModuleLoader__.load");

const mod = factory((name) => {
  if (name === "react") return React;
  throw new Error(`意外的 require：${name}`);
});
mod.apply(ctx);

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

const toolviews = registered.filter((r) => r.name === "tool.call.toolview");
check("注册了七个 toolview", toolviews.length === 7 && ["recipe_get", "recipe_search", "plan_week", "menu_shuffle", "recommend", "cook_rescue", "show_card"].every((k) => toolviews.some((r) => r.key === k)), toolviews.map((r) => r.key).join(","));

// 把渲染树压成纯文本，便于断言
function text(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node.children) return text(node.children);
  return "";
}

/** 深度找第一个满足条件的元素节点。 */
function find(node, pred) {
  if (node == null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) return node.map((n) => find(n, pred)).find(Boolean);
  if (node.tag && pred(node)) return node;
  return find(node.children, pred);
}

const sample = {
  recipe: { kind: "recipe", id: "上海-001", title: "冰糖元蹄", cuisine: "上海", chapter: "肉菜类", page: 3, minutes: 50, servings: 5, protein: 24.8, kcal: 400, allergens: [], ingredients: [{ name: "猪蹄膀", amount: "一只", grams: 750 }], steps: ["焯水", "炖"], features: "酥烂", notes: [], variants: [] },
  search: { kind: "search", total: 2, blocked: 1, items: [{ id: "a", title: "四方扣肉", cuisine: "上海", chapter: "肉菜类", minutes: 40, protein: 30, skill: "easy", features: "红亮" }] },
  plan: { kind: "plan", days: 2, people: 3, energy: "normal", menu: [{ day: 1, meals: [{ name: "晚", protein: 35, kcal: 600, dishes: [{ id: "x", title: "清蒸鳊鱼", minutes: 25, note: ["孩子那份先盛出来"] }] }] }], shopping: { buyOnce: [{ name: "鳊鱼", qty: "750 g" }], batches: [{ label: "第一批", items: [{ name: "青菜", qty: "300 g" }] }], staples: [], selfMade: [], keep: [] }, notes: ["排了你之前说想吃的"] },
  shuffle: { kind: "shuffle", people: 2, combo: "1菜1肉", rerollCount: 1, dishes: [{ id: "y", title: "油焖春笋", cuisine: "浙江", minutes: 20, protein: 3 }], hint: "可以再摇一次", askReason: false },
  rescue: { kind: "rescue", dishes: ["黄埔炒蛋（约15分钟，4人份）"], fallback: "或者干脆不做" },
  recommend: { kind: "recommend", scene: "hungry", people: 2, occasion: "daily", items: [{ id: "上海-151", title: "韭芽拌蛋皮", cuisine: "上海", chapter: "禽蛋菜类", minutes: 25, variety: 3, protein: 7, skill: "easy", isProtein: true, why: "25 分钟能上桌，3 样主辅料", main: ["鸡蛋", "韭黄"], note: [] }], hint: "三道里挑一道" },
  board: { kind: "board", title: "今晚这桌", dishes: [{ kind: "recipe", id: "上海-001", title: "冰糖元蹄", cuisine: "上海", chapter: "肉菜类", page: 3, minutes: 50, servings: 5, protein: 24.8, kcal: 400, ingredients: [{ name: "猪蹄膀", amount: "一只", grams: 750 }], steps: ["焯水", "炖"], features: "酥烂", notes: [] }], shopping: [{ group: "一次买", name: "乌参", qty: "1 条", note: "提前泡发" }], notes: ["提前一天泡发"] },
};

const byKey = Object.fromEntries(toolviews.map((r) => [r.key, r.component]));
const cases = [
  ["recipe_get", "recipe", "冰糖元蹄"],
  ["recipe_search", "search", "四方扣肉"],
  ["plan_week", "plan", "清蒸鳊鱼"],
  ["menu_shuffle", "shuffle", "油焖春笋"],
  ["recommend", "recommend", "韭芽拌蛋皮"],
  ["cook_rescue", "rescue", "黄埔炒蛋"],
  ["show_card", "board", "今晚这桌"],
];
for (const [key, kind, needle] of cases) {
  const props = { phase: "result", toolName: key, block: { meta: sample[kind], content: [{ type: "text", text: "原始输出" }] } };
  const tree = byKey[key](props);
  const out = text(tree);
  check(`${key} 渲染出「${needle}」`, out.includes(needle), out.slice(0, 80));
}

// meta 缺失 / 结构不对 → 回退 generic，不能抛
for (const block of [{}, { meta: null }, { meta: { kind: "recipe" } }, { meta: "bad" }]) {
  const tree = byKey.recipe_get({ phase: "result", toolName: "recipe_get", block: { ...block, content: [{ type: "text", text: "原始输出" }] } });
  check(`坏 meta 回退（${JSON.stringify(block).slice(0, 24)}）`, text(tree).includes("原始输出"));
}
check("preparing 阶段不崩", Boolean(byKey.recipe_search({ phase: "preparing", toolName: "recipe_search", block: {} })));

// ── 右侧栏页签 ──
const body = registered.find((r) => r.name === "sidebar.right.pane.tab");
check("注册了侧栏页签主体", Boolean(body && body.key === "dsh-recipe-homie-board"), body ? body.key : "missing");
check("注册了侧栏页签类型", tabDefs.some((d) => d.kind === "recipe-homie-board" && d.id === "dsh-recipe-homie-board"), JSON.stringify(tabDefs.map((d) => d.kind)));
check("页签主体带 inject 面", typeof body?.inject === "function");

// 空会话：给空状态，不抛
const emptyStore = body.inject("s1");
const emptyTree = body.component({ ...emptyStore, locale: "zh" });
check("空会话显示空状态", text(emptyTree).includes("这桌还是空的"), text(emptyTree).slice(0, 60));

// 有内容的会话：最后一次 shuffle + 最近取过的菜谱
events = [
  { type: "event", event: { type: "tool/result", seq: 1, data: { meta: sample.shuffle } } },
  { type: "event", event: { type: "tool/result", seq: 2, data: { meta: sample.recipe } } },
];
const liveStore = body.inject("s1");
const liveTree = body.component({ ...liveStore, locale: "zh" });
const liveText = text(liveTree);
check("页签显示摇桌标题", liveText.includes("1菜1肉"), liveText.slice(0, 80));
check("页签显示最近菜卡", liveText.includes("冰糖元蹄") && liveText.includes("猪蹄膀") && liveText.includes("焯水"));

// 「钉到侧栏」按钮：按下后打开页签
const recipeTree = byKey.recipe_get({ phase: "result", toolName: "recipe_get", block: { meta: sample.recipe, content: [] } });
const pin = find(recipeTree, (el) => el.tag === "button" && text(el) === "钉到侧栏");
check("菜卡上有「钉到侧栏」", Boolean(pin));
if (pin) {
  pin.props.onClick();
  check("点「钉到侧栏」打开 recipe-homie-board", opened.includes("recipe-homie-board"), JSON.stringify(opened));
}
const shuffleTree = byKey.menu_shuffle({ phase: "result", toolName: "menu_shuffle", block: { meta: sample.shuffle, content: [] } });
check("摇桌卡上有「钉到侧栏」", Boolean(find(shuffleTree, (el) => el.tag === "button" && text(el) === "钉到侧栏")));

// show_card 板书：对话里是同一张卡（菜 + 采购 + 提醒），页签优先显示它
const showTree = byKey.show_card({ phase: "result", toolName: "show_card", block: { meta: sample.board, content: [] } });
const showText = text(showTree);
check("show_card 卡显示菜、采购与提醒", showText.includes("冰糖元蹄") && showText.includes("乌参") && showText.includes("提前一天泡发"), showText.slice(0, 80));
check("show_card 卡上有「钉到侧栏」", Boolean(find(showTree, (el) => el.tag === "button" && text(el) === "钉到侧栏")));
const badBoard = byKey.show_card({ phase: "result", toolName: "show_card", block: { meta: { kind: "shuffle" }, content: [{ type: "text", text: "原始输出" }] } });
check("show_card 坏 meta 回退文本", text(badBoard).includes("原始输出"));

events = [{ type: "event", event: { type: "tool/result", seq: 3, data: { meta: sample.board } } }];
const boardStore = body.inject("s1");
const boardTree = body.component({ ...boardStore, locale: "zh" });
const boardText = text(boardTree);
check("页签优先显示板书（标题 + 采购）", boardText.includes("今晚这桌") && boardText.includes("乌参"), boardText.slice(0, 100));

// 板书自动弹侧栏：新卡弹一次、同一张不重复、普通菜卡不弹
opened.length = 0;
const autoProps = { phase: "result", toolName: "show_card", callId: "call-1", block: { meta: sample.board, content: [] } };
byKey.show_card(autoProps);
check("新板书自动打开侧栏", opened.length === 1 && opened[0] === "recipe-homie-board", JSON.stringify(opened));
byKey.show_card({ ...autoProps });
check("同一张板书不重复弹", opened.length === 1, JSON.stringify(opened));
byKey.show_card({ ...autoProps, callId: "call-2" });
check("新的一张板书会再弹一次", opened.length === 2, JSON.stringify(opened));
opened.length = 0;
byKey.recipe_get({ phase: "result", toolName: "recipe_get", callId: "call-3", block: { meta: sample.recipe, content: [] } });
check("普通菜卡不自动弹", opened.length === 0, JSON.stringify(opened));
opened.length = 0;
byKey.show_card({ ...autoProps, phase: "start", callId: "call-4" });
check("板书还没出结果时不弹", opened.length === 0, JSON.stringify(opened));

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
