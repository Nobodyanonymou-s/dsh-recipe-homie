/**
 * 结构清理：修「小节串行」——做法跑进用料表、用料跑进做法。
 *
 * 成因：某一道菜的「制法」标题被 OCR 吞了，或跨页切断时小节状态没跟上，
 * 于是整段步骤被当原料收进 ingredients，采购清单里就出现「将鱼去鳞…」这种行。
 *
 * 原则：只搬不改。搬完原文还在，只是换了字段；搬错了下次重建还能再修。
 */
import { splitIngredient } from "./parse.mjs";

const VERBS = /将|把|放|加|炒|烧|煮|蒸|倒|下锅|切|剁|洗|捞|盛|撒|淋|翻|拌|腌|浸|焖|炖|烤|炸|煎|取出|装盘|上笼|勾芡/;
const QTY = /[0-9零〇一二三四五六七八九十百两半]+(钱|两|斤|克|只|条|个|根|片|块|朵|棵|张)/;

/** 一行「原料」其实是步骤：有句号、够长、且不是带引导符的原料行 */
function looksLikeStep(ing) {
  const text = ing.name ?? "";
  if (!/[。；]/.test(text)) return false;
  if (text.length < 20) return false;
  if (/[·.]{2,}/.test(ing.raw ?? "")) return false;
  return true;
}

/** 一行「步骤」其实是原料：短、带分量、没有动作动词、没有句号 */
function looksLikeIngredient(step) {
  const text = String(step ?? "").trim();
  if (!text || text.length > 28) return false;
  if (/[。！？]/.test(text)) return false;
  if (!QTY.test(text)) return false;
  if (VERBS.test(text)) return false;
  return /[·.]{2,}|[\u4e00-\u9fa5]{1,6}\s*[0-9零〇一二三四五六七八九十百两半]/.test(text) || /[·.]{2,}/.test(text);
}

export function cleanupRecipe(recipe) {
  const moved = { toSteps: 0, toIngredients: 0 };
  const keptIngredients = [];
  const steps = [];

  for (const ing of recipe.ingredients ?? []) {
    if (looksLikeStep(ing)) {
      steps.push(String(ing.name).trim());
      moved.toSteps++;
    } else {
      keptIngredients.push(ing);
    }
  }
  steps.push(...(recipe.steps ?? []));

  const finalSteps = [];
  for (const s of steps) {
    if (looksLikeIngredient(s)) {
      keptIngredients.push({ ...splitIngredient(s), recoveredFrom: "cleanup" });
      moved.toIngredients++;
    } else {
      finalSteps.push(s);
    }
  }

  // OCR 常把「葱、姜、蒜各少许」压成一行当原料名：归不到标准名的行按「、」再切一次
  const reglued = [];
  for (const ing of keptIngredients) {
    if (ing.guessed && /、/.test(ing.name ?? "") && (ing.name ?? "").length > 4) {
      for (const part of ing.name.split("、").map((x) => x.trim()).filter(Boolean)) {
        reglued.push(splitIngredient(part));
        moved.toIngredients++;
      }
    } else {
      reglued.push(ing);
    }
  }

  const cleaned = moved.toSteps || moved.toIngredients;
  return {
    ...recipe,
    ingredients: reglued,
    steps: finalSteps,
    ...(cleaned ? { cleanup: moved } : {}),
  };
}
