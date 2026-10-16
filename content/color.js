// Colour parsing and the dark-theme colour mapping (Windows 11-like palette).
(() => {
  'use strict';
  const UD = (globalThis.__UD = globalThis.__UD || {});

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    let h = 0;
    let s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (!s) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }

  // ---- parsing ------------------------------------------------------------

  let ctx = null;
  const canvasCache = new Map();
  function viaCanvas(str) {
    if (canvasCache.has(str)) return canvasCache.get(str);
    let res = null;
    try {
      if (!ctx) ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#010203';
      ctx.fillStyle = str;
      if (ctx.fillStyle !== '#010203') {
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        res = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    } catch (e) {}
    canvasCache.set(str, res);
    return res;
  }

  const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const N = '(-?[\\d.]+)(%?)';
  const RGB = new RegExp('^\\s*' + N + '[\\s,]+' + N + '[\\s,]+' + N + '(?:\\s*[\\/,]\\s*' + N + ')?\\s*$');
  const HSL = /^\s*(-?[\d.]+)(deg|rad|grad|turn)?[\s,]+(-?[\d.]+)%[\s,]+(-?[\d.]+)%(?:\s*[\/,]\s*(-?[\d.]+)(%?))?\s*$/;

  function parseColor(str) {
    str = str.trim();
    let m = HEX.exec(str);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.replace(/./g, '$&$&');
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    const fn = /^(rgba?|hsla?)\((.*)\)$/is.exec(str);
    if (fn) {
      const inner = fn[2];
      if (fn[1][0].toLowerCase() === 'r') {
        m = RGB.exec(inner);
        if (m) {
          const ch = (v, pct) => clamp(pct ? (parseFloat(v) * 255) / 100 : parseFloat(v), 0, 255);
          return {
            r: Math.round(ch(m[1], m[2])),
            g: Math.round(ch(m[3], m[4])),
            b: Math.round(ch(m[5], m[6])),
            a: m[7] === undefined ? 1 : clamp(m[8] ? parseFloat(m[7]) / 100 : parseFloat(m[7]), 0, 1),
          };
        }
      } else {
        m = HSL.exec(inner);
        if (m) {
          let h = parseFloat(m[1]);
          const unit = m[2];
          if (unit === 'rad') h = (h * 180) / Math.PI;
          else if (unit === 'grad') h = h * 0.9;
          else if (unit === 'turn') h = h * 360;
          const [r, g, b] = hslToRgb(h, clamp(parseFloat(m[3]) / 100, 0, 1), clamp(parseFloat(m[4]) / 100, 0, 1));
          return {
            r, g, b,
            a: m[5] === undefined ? 1 : clamp(m[6] ? parseFloat(m[5]) / 100 : parseFloat(m[5]), 0, 1),
          };
        }
      }
      // fall through to the canvas for anything exotic (relative colours, calc, ...)
      if (/var\(/.test(inner)) return null;
    }
    if (/var\(/.test(str)) return null;
    return viaCanvas(str);
  }

  const hex2 = (n) => n.toString(16).padStart(2, '0');
  function formatColor(c) {
    if (c.a >= 0.999) return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + +c.a.toFixed(3) + ')';
  }

  // ---- mapping ------------------------------------------------------------

  // Keep the visual chroma of a colour when its lightness moves from l to nl.
  function keepChroma(l, s, nl, k) {
    const num = 1 - Math.abs(2 * l - 1);
    const den = 1 - Math.abs(2 * nl - 1);
    return den > 0.001 ? clamp((s * num * k) / den, 0, 1) : 0;
  }

  function out(h, s, nl, a) {
    const [r, g, b] = hslToRgb(h, s, clamp(nl, 0, 1));
    return { r, g, b, a };
  }

  function mapBg(c) {
    const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
    // faint dark tint (hover/zebra overlay) -> faint light tint
    if (c.a < 0.4 && l < 0.25) return { r: 255, g: 255, b: 255, a: c.a };
    // saturated mid-tone: brand colour / button, keep it vivid but not glaring
    if (s >= 0.3 && l > 0.2 && l <= 0.75) {
      return out(h, Math.min(1, s * 0.92), Math.min(l, 0.55) * 0.82, c.a);
    }
    if (l >= 0.5) {
      const nl = Math.min(0.36, 0.125 + (1 - l) * 0.7);
      return out(h, keepChroma(l, s, nl, 0.9), nl, c.a);
    }
    const nl = 0.095 + l * 0.52;
    return out(h, keepChroma(l, s, nl, 1), nl, c.a);
  }

  function mapFg(c) {
    const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
    let nl = l <= 0.6 ? 0.92 - l * 0.45 : 0.65 + (l - 0.6) * 0.9;
    nl = Math.min(nl, 0.97);
    if (s > 0.35) nl = clamp(nl, 0.58, 0.78);
    return out(h, keepChroma(l, s, nl, 1), nl, c.a);
  }

  function mapBd(c) {
    const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
    const nl = Math.min(0.5, 0.24 + (1 - l) * 0.4);
    return out(h, keepChroma(l, s, nl, 0.8), nl, c.a);
  }

  const MAPPERS = { bg: mapBg, fg: mapFg, bd: mapBd, sh: mapBg };

  function transformColor(c, role) {
    if (c.a === 0) return c;
    return (MAPPERS[role] || mapBg)(c);
  }

  UD.clamp = clamp;
  UD.rgbToHsl = rgbToHsl;
  UD.hslToRgb = hslToRgb;
  UD.parseColor = parseColor;
  UD.formatColor = formatColor;
  UD.transformColor = transformColor;
})();
