# dsh-recipe-homie

English | **[中文](./README.md)**

> A DSH plugin for Chinese cooking: canonical recipes with original weights, menus that fit *you*, shopping lists organized around groceries, and a cure for "what's for dinner".
> DSH 里的中国菜谱插件：检索正派做法、按人排菜单、算得出采购清单。

Turns a shelf of classic Chinese cookbooks into a structured recipe library with original weights and page citations — fully local, no network, search/plan/shuffle through native cards. A sampled corpus ships with the repo so it works out of the box; build the full library from your own book sources.

## What it does for you

- **Find dishes** — search by ingredient / cuisine / technique / leftovers; hits carry verbatim archaic units ("一两五钱 ≈ 75g"), page citations, and estimated time; when another volume has its own version of the same dish, compare them right in the detail view
- **Remember you** — a two-layer profile: long-term facts (likes, dislikes, allergies, skills) vs. time-boxed periods (cut / pregnancy / bulking, with start/end dates that auto-expire); set it once, it applies everywhere
- **Understand food restrictions in four tiers** — allergies block the dish at any trace; main-ingredient dislikes swap the dish; garnish-level ones get a "no-garlic version: omit 大蒜 (~15g)" and the recipe still works; low-sodium/oil never hides dishes, it just appends a reduction tip
- **Plan around groceries, not dishes** — ≤6 people, 3-day or weekly menus; meat bought once and frozen in portions, vegetables batched by shelf life, quantities rounded to what you can actually buy (50g greens → 300g), cured ham marked "buy ready-made"
- **Tell the truth** — daily protein/kcal report honest gaps against your day-level targets; the corpus has no breakfast, so it says "breakfast on your own" instead of faking one
- **Fight decision fatigue** — the random challenge gives exactly two rolls per round, then stops rolling and asks: tired, no appetite, missing ingredients, or no inspiration? — with a way out for each answer
- **Teach, honestly** — say "I want to learn something hard" to unlock the hard tier; kung-fu dishes carry hand-calibrated durations (authentic 开水白菜: hard, ~240 min — no 20-minute shortcuts)
- **Native experience** — search/recipe/menu/chalkboard cards; a settled menu can be **pinned to the sidebar** as your recipe + shopping list

## Install

**Not on the plugin marketplace, not on npm** — install straight from GitHub (the package lives in the `recipe-homie/` subdirectory, so point `#path:` at it):

```sh
dsh plugin --profile desktop add "https://github.com/Nobodyanonymou-s/dsh-recipe-homie#path:recipe-homie"
```

Offline / slow-network fallback — clone and pack a tarball locally:

```sh
git clone https://github.com/Nobodyanonymou-s/dsh-recipe-homie.git
cd dsh-recipe-homie/recipe-homie
npm pack --pack-destination ./dist
dsh plugin --profile desktop add ./dist/dsh-recipe-homie-<version>.tgz
```

After installing, point it at a data directory — pick one:

- **Try it now**: copy [data-sample](./recipe-homie/data-sample/) (a sampled corpus, 160 dishes across every category) to a writable location — the plugin writes profile and state files there — and set `dataDir` in the mount config (`cordis.patch.yml` `config:` block) to it
- **Full library**: the repo ships no complete recipe data (derived from the owner's book collection, not distributed) — bring your own book sources, run `build → integrate` to produce `data/`, point `dataDir` there, and copy [presets.example.json](./recipe-homie/presets.example.json) to `data/presets.json`; see the [tech doc](./recipe-homie/README.md)

Then restart DSH.

First run: tell it your tastes and restrictions (or copy an [example profile](./画像示例.md) and edit), then just ask "what's for dinner tonight".

## Docs

- [Example profiles](./画像示例.md) (Chinese) — three complete profiles + "how the design takes care of each", edit and use
- [Tech doc](./recipe-homie/README.md) — data pipeline, nutrition methodology, tool contracts, known limits

## Design principles

Recipes are fixed; cooking is flexible. A menu is an option, not a task. Ask why, never police metrics. Memory with warmth, always leave a way out.

## License

Code distributed under [Apache-2.0](./LICENSE). Nutrition reference data from the [community-structured 6th edition of the China Food Composition Table](https://github.com/Sanotsu/china-food-composition-data) (factual data, with OCR-correction risk disclaimer). Recipe corpus is not distributed with this repo.
