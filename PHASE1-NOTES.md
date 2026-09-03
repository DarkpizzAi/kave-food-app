# Phase 1 notes

> Written while Phase 1 was built under `kave-hub/food/app/`. On 2026-09-01 the
> app moved here (shell only) and the data + build tools moved to the private
> repo: `data/shopping-seed.json` -> `kave-hub/food/data/shopping-seed.json`,
> `data/recipes.sample.json` -> `kave-hub/food/data/recipes.json`,
> `tools/*` -> `kave-hub/food/tools/` (`build_recipe_sample.py` renamed
> `build_recipes.py`). The public build no longer bundles any data; it loads
> an empty list until Phase 2. Path references below are as they were then.

## What works

- **Bottom nav**, four icon tabs (cart / clipboard / calendar / cog, each
  `aria-label`led) for List, Recipes, Planner, Settings. App always opens on
  List, even if it was closed on another tab.
  - The **active** tab draws its icon in `--accent` stroke plus a
    `color-mix(--accent 26%, transparent)` fill wash, so the selected icon
    reads as "filled in" without becoming a solid blob.
  - The List/cart icon carries a **count badge** (`#listBadge`, set in
    `renderList`): the number of **unchecked** items, `99+` above 99, hidden
    at 0.
- **Shopping list**: Google Keep style. One blank input at the top; type a name,
  Enter adds it. Active items listed with a square checkbox; tick to move to a
  collapsible "N ticked items" block below (greyed, struck through). Per-row ✕
  removes entirely. Persists to `localStorage` (`foodapp.list`); survives
  reload.
  - **Suggestions**: while typing, a dropdown lists ticked items whose name
    contains what you typed (plain substring, accent- and case-insensitive).
    Clicking one un-ticks that item instead of adding a duplicate. Pressing
    Enter on text that exactly matches a ticked item also just un-ticks it.
  - **Starter list**: `data/shopping-seed.json`, 511 items from the household
    Keep note, lightly tidied (see below). Loaded once, only when
    `localStorage` is empty. All ticked except Basil and Rice.
  - Manual add is name-only now (no qty/unit/note fields). The data model still
    carries qty/unit/note for when the meal planner pushes items in later.
  - **"Clean up"** button on the ticked-items row: groups ticked items whose
    names match after folding accents/case and stripping a trailing quantity
    (` 3`, ` 200g`, ` x2`) or a trailing bracketed size note that contains a
    digit (`Minced beef (2x400g)` -> `Minced beef`; `(spicy)` / `(Keisy)` are
    kept). `tidyKey()` loops the strips until stable. Keeps the shortest of
    each group, removes the rest.
    No confirm; a 3.5s banner reports how many went ("Removed 4 duplicate
    ticked items"). Deliberately dumb stripping, so it can occasionally
    over-merge specific-size items ("Trash bags 35L" / "30L" -> one) - low
    stakes on the ticked graveyard, user re-types once if needed. Only touches
    ticked items. A fuzzy untick-on-add (stop dupes forming) is the natural
    follow-up.
- **Recipes**: 15 cards from `data/recipes.sample.json`, shown as a
  multi-column grid of tappable cards. Each card: left-aligned Fraunces title at
  the top, then a bottom-left **time only** (`20min + 3h` format, omitted
  entirely - no placeholder, no category anymore - when the card has neither
  prep nor cook), and a **3-dot effort meter** bottom-right (`margin-left:auto`
  on `.dots`, so it stays right-aligned whether or not the time line is
  present). A **pixel icon** sits top-right: Hugo's
  `kave-hub/hub/js/icons.js` ported to `pixel-icons.js` (an emoji drawn on a
  16px canvas, upscaled unsmoothed; `foodEmoji(name, category)` keyword map,
  with `bolognaise` / `keftas et tomates` added for the renamed recipes) -
  **full colour**, as originally ported; a recoloured on-palette-green version
  was tried and reverted, see Deviations.
  Effort is derived from the category (plat = 1, soupe / marinade / "version
  rapide" = 2, mijoté = 3). No flags, no servings on the card (servings live in
  the detail view). 10px radius to match the search bar. **All cards take the
  height of the tallest visible one** (`equaliseCards()` measures after each
  render, on `document.fonts.ready`, and on resize; recomputes when a filter
  changes the set). CSS grid only equalises per row, so this is done in JS
  synchronously, not via rAF, because the in-app browser pane throttles rAF.
  - **Two horizontal-scroll rails** first, labelled "Cuisine" / "Type" in
    Fraunces italic. Chips are **ordered by how many recipes have that value**,
    most first (`countedValues()`, ties alphabetical), so the order re-sorts as
    recipes are added. Cuisine and Type combine as AND; search ANDs on top.
    Name search is accent- and case-insensitive. When a rail actually overflows
    (more chips than fit), its right edge **fades out** (`rail-fade` class, a
    CSS mask) instead of hard-cutting a chip mid-word - the fade clears once
    scrolled to the end. `updateRailFade()` runs after each render and on
    scroll/resize. Type only ever fits (5-6 chips), so it never fades; that's
    expected, not a bug.
  - **Control row below the rails** (`#recipeControlRow`, built in JS): circular
    search icon left, then `✕ Clear` (only when a chip / search / non-default
    sort is active - resets all of them), a spacer, and the **sort toggle** on
    the right ("Simplest first" default / "Most complex first"; ties always
    A→Z). Tapping the search icon swaps the whole row for a full-width search
    field (`‹` back + input + `✕`) that clears the query and collapses on close;
    Clear and sort are hidden while searching.
  - Tap a card and the detail sheet **slides up from the bottom** (`.detail`
    `translate(-50%,100%) -> translate(-50%,0)`, 0.28s; honours
    `prefers-reduced-motion`). It opens below the "Recipes" header (`.detail`
    top = `--header-h`) so the header and bottom nav both stay visible - the
    sheet slides up *under* the nav. It's constrained to the same centred
    `min(100%, 720px)` column as the rest of the app (`left:50%` +
    `translateX(-50%)`), not full-viewport.
  - Under the "Recipes" header sits a second, **green-tinted sticky bar**
    (`.detail-bar`, `--accent-soft`) with a drag handle and just the recipe name
    in Fraunces italic. Body then goes straight into the Servings bar, mirroring
    the recipes home (header -> filters).
  - **Closing**: no button. **Tap or swipe down on the name bar** (drag follows
    the finger, releases past ~90px to close, else springs back), **tapping the
    Recipes tab again** while its sheet is up, or the Android back gesture - all
    slide the sheet **back down** and out. History is one `pushState` per open,
    balanced by `history.back()`, so it never accumulates (`sheetHasHistory`
    bookkeeping). `openRecipe` does `history.pushState({recipeSheet:true})`;
    `closeRecipe` calls `history.back()`, and a `popstate` listener runs
    `slideSheetDown()` (remove `.shown`, wait `transitionend`/450ms, set
    `hidden`, null `detailState`).
  - **Switching to another tab does not close the sheet.** An open recipe is
    "parked": leaving Recipes hides it instantly (`parkRecipe()`, no swoop -
    `transition:none`, `hidden`, keep `detailState`, reset add/custom mode),
    coming back to Recipes restores it just as instantly (`unparkRecipe()`),
    with servings and scroll intact. So the close triggers above only fire
    while you are actually on the Recipes tab looking at the sheet. A back
    gesture while parked on another tab just discards the recipe (next visit to
    Recipes shows the card grid, not the sheet).
  - The "base portions not confirmed" note now sits **after the ingredient
    list**.
  - Note: the in-app browser pane throttles CSS transitions when it's not
    painting, so the slide doesn't visibly animate in that test harness (end
    state is correct); it animates normally in a real browser / on the phone.
- **Scaler**: one-line **Servings** bar styled exactly like a recipes-home
  filter rail - no box, "Servings" in Fraunces italic (like the "Cuisine" /
  "Type" labels), then horizontally-scrolling preset bubbles, then Reset.
  Presets come from the
  `presets` field (chosen so whole-only ingredients stay tidy, base always
  included, 1-person bubble where the dish makes sense for one). A **Custom**
  bubble turns into a numeric input; Enter adds that value as the last bubble,
  highlighted. **Reset** always returns to the base.
- **Detail sections**: `Ingredients` (Fraunces h3) and `Preparation`. No
  separate "cooking" section - the cards store one method list; splitting it
  would be a recipe-data change.
- **Add ingredients to the shopping list from a recipe**: a "Shopping mode"
  toggle switch (`role="switch"`, the bottom-nav List cart icon beside the
  track) sits right-aligned with the "Ingredients" heading. Flipping it on
  (`.switch.on` - accent track, knob slides right) enters add-mode and every
  ingredient row grows a trailing round `+` button (a fourth `max-content`
  grid column,
  added/removed from `.ing-list`'s inline `grid-template-columns` so the
  subgrid rows still line up). Tapping `+` pushes that ingredient onto the
  shopping list, **name first then quantity** ("Spaghettis 150 g", matching
  how manual list items already read) at whatever quantity is **currently
  displayed** (original at base servings, the scaled value once a non-base
  serving is picked), and the button flips to a green check; tapping the
  check removes that item again and flips back to `+`. Each pushed item is
  tagged `source: "recipe:<slug>#<index>"` (used to de-dupe and to find the
  item for removal - tapping `+` on something already on the list just ticks
  it, no second copy). The tick state is **per add-mode session**
  (`detailState.added`, a Set of indices). Add-mode and its ticks reset only
  when you 1) tap the cart toggle or 2) close the recipe (swipe-down / Recipes
  tab tap). Switching tabs and coming back **keeps** add-mode on with its
  ticks intact (`parkRecipe()` leaves `addMode`/`added` alone). Re-entering a
  fresh add-mode session shows all `+` again, even for items still on the list. Tapping the green cart icon again exits add-mode: the row
  buttons disappear and the icon reverts to neutral. In add-mode the rows
  also gain vertical room and centre their cells (`.ing-list.adding`,
  `align-items: center`, taller `min-height`), so the quantity and name sit
  level with the middle of the `+`, which is itself the same 36px as the
  cart toggle and flush under it (same right edge). Add-mode lives on
  `detailState`, which is thrown away and rebuilt fresh (`addMode: false`)
  every time a recipe sheet opens, so **leaving the recipe always resets it**
  - reopening never comes back in add-mode. Already-added items stay on the
  shopping list either way; the toggle only hides/shows the affordance.
  Verified add + remove + toggle-off + reopen-resets, plus the scaled-
  quantity case (150 g at 2 servings -> 75 g pushed at 1 serving), in-browser
  with no console errors.
- **Ingredient table**: CSS-subgrid so quantities line up in columns across
  rows - original in col 1, adjusted in col 2 when a non-base serving is picked,
  name in col 3. At base servings the table is 2-column. Styled as a **ruled
  page**: each row is a "line" (`--rule` bottom border, ~38px, text baseline-sat
  on it) with a left **margin rule** (`--rule-strong` vertical line). Both
  tokens are part of every palette's set.
- **Colour = "adjusted from base".** At base servings, the selected bubble is
  neutral (white, dark ring - `.bubble.on.base`) and every quantity is `--text`.
  Pick any other serving and only *that* changes turn green (`--accent`): the
  selected bubble and the col-2 adjusted values. Originals stay `--text` and are
  never hidden, so the reader can override the rounding by eye. Non-numeric
  ingredients ("Vin rouge", "au goût") sit name-only. Pinning removed.
  Rounding is still unit-based (`isCountUnit`); fractionnement-aware rounding
  is a roadmap item.
- **Settings**, in order: **Theme**, **Colour palette**, **User**,
  **GitHub token**, **Sync**.
  - **Theme** picker (Light = sun / Dark = moon / **System** = half-filled
    circle, the usual "auto" glyph), persisted, applied via `data-theme` on
    `<html>` with the media query guarded so an explicit choice wins over the
    OS and "system" follows it live.
  - **Colour palette** picker: Google Drive / Google Keep / WhatsApp /
    Todoist, default **Keep**. Same button style as the Theme picker (flex,
    wrap, hug the label). Each button shows a four-slice circle (top-left
    light bg, top-right dark bg, bottom-left light accent, bottom-right dark
    accent, drawn with one `conic-gradient`) plus the name. Every palette is a
    full light + dark token set in `styles.css` keyed by `[data-palette]` on
    `<html>` (absent = Keep). `applyPalette()` sets the attribute,
    `updateThemeColor()` keeps the browser chrome colour in sync with the
    palette's resolved bg. `PALETTES` in `app.js` holds the id -> bg map;
    an unknown stored id falls back to Keep.
  - **User** (Hugo / Isa, used as `addedBy` on new items); **GitHub token**
    field (stored to `foodapp.settings`, not used yet); disabled "Sync all
    tabs" button.
- **Pull to sync**: pull down from the top of any tab past ~64px and it shows
  "Syncing <Tab>" with a spinner, holds ~0.7s, snaps back and re-renders that
  tab. Only `<main>` (the tab content) translates; the sticky header and bottom
  nav stay put, and the indicator sits flush below the header (`--header-h`,
  measured in JS and re-measured on resize / font load). Phase 1 no-op (`syncCurrentTab()` is a timeout); Phase 2 swaps it for the
  GitHub fetch of just that tab's data with ETag / If-None-Match. Chrome
  Android's own pull-to-refresh is suppressed with `overscroll-behavior-y:
  contain`. Android only (per `household-food-app` memory), no iOS handling.
- **Headers** use Fraunces (the display face shared with the Groceries
  Dashboard title). Page title is Fraunces italic 600; recipe name /
  "Preparation" are Fraunces 600. Body stays system-ui. Page headers are
  Title Case ("Shopping List", "Meal Planner").
- Light / dark resolves per the Theme setting (see Settings). Mobile-first,
  44px tap targets, safe-area padding for the bottom bar. Checked at 375px
  and desktop.

## Seed list tidy-up (`data/shopping-seed.json`)

The raw Keep note (~600 lines, `tools/keep-note-raw.txt`) becomes 511 items via
`tools/build_shopping_seed.py`: trim whitespace and a trailing `?` / `*3`, drop
a leading count ("2 ", "Isa) "), case-insensitive dedupe, and fix clear
misspellings / missing accents (Albahaha -> Albahaca, Basilique -> Basilic,
Coffe -> Coffee, Creme fraiche -> Crème fraîche, ...).

**Multilingual variants are kept on purpose** (Oignon, Onion, Cebola all stay;
singular and plural both stay). Nothing is translated or merged across
languages. To change a spelling call, edit `TYPOS` in the script or just
hand-edit the JSON. Regenerating from a fresh Keep export is a manual paste,
not automated.

Verified in-browser: add + reload persistence, scale bolognese to 6 (mince
400 -> 600 g, bouillon 200 -> 300 ml, vin rouge unchanged), pin mince to 500 g
(servings -> 5, bouillon -> 250 ml), soup filter (Pho, Ramen, Soupe à l'oignon),
search "pho" -> 1 result.

## Stubbed / deferred

- **Planner**: static "coming soon" panel, no logic.
- **No network**: no GitHub read or write, no poll, no rate-limit banner, no
  read-only mode. The banner element exists but only fires if the sample JSON
  fails to load.
- **Meal-planner "merge ingredients, ask already-have-this" push**: still the
  planner's job, not built. (Per-ingredient add from a recipe detail, at the
  displayed quantity, now works - see above.)

## Recipe names harmonised (2026-09-01)

Eight recipes renamed for a consistent French, sentence-case, short style, in
the cards (`# title`), `food/data/recipes.md`, and `recipes.sample.json`:
Bolognese -> Bolognaise, Fajitas -> Fajitas de poulet, Korean Nuggets ->
Nuggets coréens, Pâtes kefta tomates -> Pâtes aux keftas et tomates, Quiche
Lorraine -> Quiche lorraine, Ramen -> Ramen express, Thit Kho -> Thịt kho,
Travers de porc / poulet à la citronnelle -> Travers à la citronnelle. Slugs
and filenames unchanged.

## Deviations from the plan

- Tried recolouring the pixel icons to a green ramp from the app palette
  (`--accent` -> `--accent-soft` by luminance); flattening a colour emoji to
  one hue loses too much shape, several came out as indistinct blobs.
  Reverted to full-colour emoji (2026-09-01).
- Build tool is `tools/build_recipe_sample.py` (Python), not a Node `.mjs`:
  this machine has Python 3.12 and no Node.
- `data/recipes.sample.json` is generated by `build_recipe_sample.py`: names,
  times, clean ingredients from the cards; `mainIngredient` / `portionsConfirmed`
  / `presets` from the script's `META` table; and hand-curated ingredients /
  steps for the four cards that don't parse (`pates-kefta-tomates`,
  `pho`, `quiche-lorraine`, `carbonara`) merged in from
  `tools/curated-overrides.json`. So a plain re-run is now safe.
- Ingredient pinning was removed; the Servings bubble flow replaced it.

## Code shape (after the 2026-09-01 review pass)

- **State lives in three places by lifetime.** `store.state` is the persisted
  model (list + settings), mirrored to `localStorage` on every mutation and the
  only thing `render()` reads. `recipeFilters`, `detailState` and `checkedOpen`
  are module-level **transient UI state**: not persisted, not on `store`, and
  their handlers call the relevant `renderX()` directly rather than
  `store.notify()`. Persisted setters (`store.setTheme` etc.) go through
  `notify()` -> `render()`.
- **Rendering is full re-render on every interaction.** `renderDetail()`
  rebuilds `#detailBody` and re-binds its listeners each call, and re-invokes
  itself after any change. Fine at this size; the thing to know before adding
  features is that nothing in the sheet is incrementally updated.
- **One `uid()`**, one hoisted `HTML_ENTITIES` map for `escapeHtml`, one
  `resize` listener in `wire()` (rail fade + debounced card equalise) plus the
  header-height one in `initPullToSync`.
- Review removed: an unused `#headerActions` slot, a dead `.primary` /
  `form.add-form` rule, two unread locals in `renderDetail`, and a broken
  `var(--line-strong)` token reference in `.ptr-spinner` (now `--rule-strong`).
- Settings group labels are `<p class="field-label">`, not `<label for>`
  pointing at a `<div>` (which is invalid); `setToken` / `refreshBtn` keep
  their `<label for>` since those target real form controls.

## Phase 2 picks up

GitHub Contents API client, the read/apply/PUT + 409 retry-merge loop for
`shopping-list.json`, the real quantity parser + a one-time kitchen review of
the 15 cards, the 60s poll, the manual Refresh, the rate-limit / offline
banner, and read-only mode when no token.
