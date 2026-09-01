/* Retro pixel icons: an emoji drawn on a tiny canvas, upscaled without
   smoothing for a pixelised look. Ported from kave-hub/hub/js/icons.js
   (Hugo's icons). No image assets, works offline. */
"use strict";

const foodPixelIcon = (() => {
  function pixelEmoji(emoji, size = 40, grid = 16) {
    const small = document.createElement("canvas");
    small.width = grid;
    small.height = grid;
    const sctx = small.getContext("2d");
    sctx.font = (grid - 2) + 'px "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", serif';
    sctx.textAlign = "center";
    sctx.textBaseline = "middle";
    sctx.fillText(emoji, grid / 2, grid / 2 + 1);

    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    out.style.width = out.style.height = size + "px";
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.drawImage(small, 0, 0, size, size);
    out.className = "pix";
    out.setAttribute("aria-hidden", "true");
    return out;
  }

  const strip = (s) =>
    (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  function match(pairs, name) {
    const n = strip(name);
    for (const [kw, e] of pairs) if (n.includes(kw)) return e;
    return null;
  }

  // Order matters: first match wins.
  const FOOD = [
    ["fajitas", "\u{1F32E}"], ["tacos", "\u{1F32E}"], ["al pastor", "\u{1F32E}"],
    ["salade", "\u{1F957}"],
    ["bouillon", "\u{1F372}"], ["fond", "\u{1F372}"], ["soupe a l'oignon", "\u{1F9C5}"],
    ["veloute", "\u{1F383}"], ["potimarron", "\u{1F383}"],
    ["soupe", "\u{1F372}"],
    ["keftas et tomates", "\u{1F35D}"], ["kefta tomates", "\u{1F35D}"], ["kefta", "\u{1F9C6}"],
    ["big mac", "\u{1F354}"], ["burger", "\u{1F354}"],
    ["grilled cheese", "\u{1F9C0}"], ["sandwich", "\u{1F96A}"],
    ["carbonara", "\u{1F35D}"], ["bolognaise", "\u{1F35D}"], ["bolognese", "\u{1F35D}"],
    ["aglio", "\u{1F35D}"], ["pates", "\u{1F35D}"],
    ["pho", "\u{1F35C}"], ["ramen", "\u{1F35C}"],
    ["bourguignon", "\u{1F958}"], ["pot-au-feu", "\u{1F958}"], ["thit kho", "\u{1F958}"],
    ["nuggets", "\u{1F357}"], ["teriyaki", "\u{1F357}"], ["cordon bleu", "\u{1F357}"],
    ["travers", "\u{1F356}"], ["porc", "\u{1F356}"], ["citronnelle", "\u{1F356}"],
    ["poulet", "\u{1F357}"],
    ["quiche", "\u{1F967}"],
    ["riz", "\u{1F35A}"],
    ["shakshuka", "\u{1F373}"], ["tortilla", "\u{1F373}"],
    ["tian", "\u{1F346}"], ["legumes", "\u{1F955}"],
    ["saumon", "\u{1F363}"], ["tataki", "\u{1F363}"], ["thonade", "\u{1F41F}"],
    ["pesto", "\u{1F33F}"], ["green sauce", "\u{1F96C}"],
    ["bearnaise", "\u{1F963}"], ["poivre", "\u{1F963}"], ["sauce", "\u{1F963}"],
    ["frites", "\u{1F35F}"],
    ["pickled", "\u{1F9C5}"], ["oignon", "\u{1F9C5}"],
    ["guacamole", "\u{1F951}"],
    ["cheese cake", "\u{1F370}"],
    ["panados", "\u{1F364}"],
    ["kebab", "\u{1F959}"],
  ];
  const FOODCAT = [
    ["mijote", "\u{1F958}"], ["viande", "\u{1F969}"], ["poisson", "\u{1F41F}"],
    ["soupe", "\u{1F372}"], ["sandwich", "\u{1F96A}"], ["sauce", "\u{1F963}"],
    ["bouillon", "\u{1F372}"], ["garniture", "\u{1F35F}"], ["marinade", "\u{1F356}"],
    ["tartiner", "\u{1F951}"], ["dessert", "\u{1F370}"],
  ];

  function foodEmoji(name, category) {
    return match(FOOD, name) || match(FOODCAT, category) || "\u{1F37D}\u{FE0F}";
  }

  return (name, category, size = 40) => pixelEmoji(foodEmoji(name, category), size);
})();
