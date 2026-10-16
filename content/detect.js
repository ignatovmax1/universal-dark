// Samples the effective background colour across the viewport to decide whether a
// page is dark or light.
(() => {
  'use strict';
  const UD = globalThis.__UD;
  if (!UD) return;

  const MEDIA = new Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'picture', 'svg', 'image']);
  const GRID = 6;

  const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  function canvasLum(prefersDark) {
    const cs = getComputedStyle(document.documentElement).colorScheme || '';
    const dark = /dark/.test(cs) && (!/light/.test(cs) || prefersDark);
    return dark ? 0.07 : 1;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function measure() {
    const vw = innerWidth;
    const vh = innerHeight;
    const res = { dark: 0, light: 0, total: 0 };
    if (!vw || !vh || !document.body) return res;
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const cache = new Map();

    const bgOf = (el) => {
      if (cache.has(el)) return cache.get(el);
      let v;
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== 'none') v = null;
      else {
        const c = UD.parseColor(cs.backgroundColor);
        if (c && c.a >= 0.5) v = luminance(c);
        else {
          const parent = el.parentElement || (el.getRootNode && el.getRootNode().host);
          // the root's transparent background is the canvas: it takes the body's colour
          if (el === document.documentElement) {
            const bc = UD.parseColor(getComputedStyle(document.body).backgroundColor);
            v = bc && bc.a >= 0.5 ? luminance(bc) : canvasLum(prefersDark);
          } else v = parent ? bgOf(parent) : canvasLum(prefersDark);
        }
      }
      cache.set(el, v);
      return v;
    };

    for (let iy = 0; iy < GRID; iy++) {
      for (let ix = 0; ix < GRID; ix++) {
        const el = deepElementFromPoint(Math.floor(((ix + 0.5) * vw) / GRID), Math.floor(((iy + 0.5) * vh) / GRID));
        if (!el || MEDIA.has(el.localName)) continue;
        const lum = bgOf(el);
        if (lum == null) continue;
        res.total++;
        if (lum < 0.3) res.dark++;
        else if (lum > 0.5) res.light++;
      }
    }
    return res;
  }

  UD.measure = measure;
  UD.isDarkPage = (m) => m.total >= 6 && m.dark / m.total >= 0.75;
  UD.isLightPage = (m) => m.total >= 8 && m.light / m.total >= 0.6;
})();
