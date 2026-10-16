// Decides whether an image is "dark ink on a transparent background" (a typical logo or
// icon), which would disappear on a dark page. Shared by the content script and the
// service worker, so it must not touch the DOM.
(() => {
  'use strict';
  const UD = (globalThis.__UD = globalThis.__UD || {});

  const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  // data: RGBA bytes of a downscaled image
  UD.analyzePixels = (data) => {
    let total = 0;
    let transparent = 0;
    let opaque = 0;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      total++;
      if (data[i + 3] < 128) {
        transparent++;
        continue;
      }
      opaque++;
      if (lum(data[i], data[i + 1], data[i + 2]) < 0.3) dark++;
    }
    return !!total && transparent / total >= 0.1 && opaque > 0 && dark / opaque >= 0.75;
  };

  const NAMED = { black: [0, 0, 0], white: [255, 255, 255] };

  function paintLum(v) {
    v = v.trim().toLowerCase();
    if (NAMED[v]) return lum(...NAMED[v]);
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})/.exec(v);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.replace(/./g, '$&$&');
      return lum(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
    }
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
    if (m) return lum(+m[1], +m[2], +m[3]);
    return 1; // unknown paint: treat as light, i.e. leave the image alone
  }

  // text: SVG source
  UD.analyzeSvg = (text) => {
    if (/<image[\s>]|<filter[\s>]|gradient/i.test(text)) return false;
    if (!/<(path|rect|circle|ellipse|polygon|polyline|text|line)[\s>]/i.test(text)) return false;
    const colors = [];
    const re = /(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*([^"';>\s}]+)/gi;
    let m;
    while ((m = re.exec(text))) {
      const v = m[1];
      if (/^(none|transparent|currentcolor|inherit|url\()/i.test(v)) continue;
      colors.push(v);
    }
    if (!colors.length) return true; // default fill is black
    return colors.every((c) => paintLum(c) < 0.3);
  };
})();
