// CSS value / declaration / rule rewriting. Every colour-bearing declaration of a
// stylesheet is re-emitted (same selector, same priority, same order) with
// dark-theme colours, into an override sheet that is adopted after the page's own.
(() => {
  'use strict';
  const UD = globalThis.__UD;
  if (!UD) return;

  const SYSTEM = new Set(
    ('canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext ' +
      'highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext ' +
      'activeborder activecaption appworkspace background buttonhighlight buttonshadow captiontext inactiveborder ' +
      'inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow ' +
      'threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext').split(' ')
  );
  const SKIP = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto']);

  const wordCache = new Map();
  function isColorWord(w) {
    let v = wordCache.get(w);
    if (v === undefined) {
      v = !SKIP.has(w) && !SYSTEM.has(w) && CSS.supports('color', w) && !!UD.parseColor(w);
      wordCache.set(w, v);
    }
    return v;
  }

  // ---- low-level scanning -------------------------------------------------

  function matchParen(s, open) {
    let depth = 0;
    let q = '';
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return i;
    }
    return s.length - 1;
  }

  function topLevelComma(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) return i;
    }
    return -1;
  }

  function splitDecls(text) {
    const res = [];
    let depth = 0;
    let q = '';
    let start = 0;
    const flush = (end) => {
      const part = text.slice(start, end);
      start = end + 1;
      const colon = part.indexOf(':');
      if (colon < 1) return;
      let name = part.slice(0, colon).trim();
      let value = part.slice(colon + 1).trim();
      if (!name.startsWith('--')) name = name.toLowerCase();
      let imp = false;
      const m = /\s*!\s*important\s*$/i.exec(value);
      if (m) {
        imp = true;
        value = value.slice(0, m.index);
      }
      res.push({ name, value, imp });
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth === 0) flush(i);
    }
    flush(text.length);
    return res;
  }

  // ---- values -------------------------------------------------------------

  const TOKEN =
    /url\(|"|'|var\(|(?:rgba?|hsla?)\(|#[0-9a-fA-F]{3,8}(?![\w-])|(?<![\w\-#.$%])[a-zA-Z][a-zA-Z]*(?![\w(\-])|[a-zA-Z-]+\(/gi;
  const SLASH_ALPHA = /^([^/]*?)\s*\/\s*(.+)$/s;
  const COMMA_ALPHA = /^\s*([\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?)\s*,\s*(var\(.+\)|calc\(.+\))\s*$/s;

  const valueCache = new Map();

  function rewriteVar(inner, role) {
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (!/^--[\w-]+$/.test(name)) return 'var(' + inner + ')';
    const fb = comma < 0 ? '' : ',' + transformValue(inner.slice(comma + 1), role);
    return 'var(--ud-' + role + '-' + name.slice(2) + ',var(' + name + fb + '))';
  }

  // rgb()/hsl() whose alpha (or only alpha) is a var()/calc(): transform the colour part.
  function colorWithDynamicAlpha(fn, inner, role) {
    let core;
    let alpha;
    let m = SLASH_ALPHA.exec(inner);
    if (m && /var\(|calc\(/.test(m[2]) && !/var\(/.test(m[1])) {
      core = m[1];
      alpha = m[2];
    } else if ((m = COMMA_ALPHA.exec(inner))) {
      core = m[1];
      alpha = m[2];
    } else return null;
    const base = UD.parseColor(fn + '(' + core + ')');
    if (!base) return null;
    const t = UD.transformColor(base, role);
    return 'rgb(' + t.r + ' ' + t.g + ' ' + t.b + ' / ' + alpha + ')';
  }

  function transformValue(value, role) {
    if (!value) return value;
    const key = role + '\u0001' + value;
    const hit = valueCache.get(key);
    if (hit !== undefined) return hit;

    let out = '';
    let last = 0;
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(value))) {
      const tok = m[0];
      const start = m.index;
      let repl = null;
      let end = start + tok.length;

      if (tok === '"' || tok === "'") {
        let i = start + 1;
        while (i < value.length && value[i] !== tok) i += value[i] === '\\' ? 2 : 1;
        TOKEN.lastIndex = i + 1;
        continue;
      }
      const lower = tok.toLowerCase();
      if (lower === 'url(') {
        TOKEN.lastIndex = matchParen(value, start + 3) + 1;
        continue;
      }
      if (lower === 'var(') {
        end = matchParen(value, start + 3) + 1;
        repl = rewriteVar(value.slice(start + 4, end - 1), role);
        TOKEN.lastIndex = end;
      } else if (/^(rgba?|hsla?)\($/.test(lower)) {
        const close = matchParen(value, start + tok.length - 1);
        const inner = value.slice(start + tok.length, close);
        const c = UD.parseColor(lower + inner + ')');
        if (c) {
          repl = UD.formatColor(UD.transformColor(c, role));
        } else {
          repl = colorWithDynamicAlpha(lower.slice(0, -1), inner, role);
        }
        if (repl === null) continue; // unknown shape: keep scanning inside
        end = close + 1;
        TOKEN.lastIndex = end;
      } else if (tok[0] === '#') {
        const c = UD.parseColor(tok);
        if (!c) continue;
        repl = UD.formatColor(UD.transformColor(c, role));
      } else if (tok.endsWith('(')) {
        continue; // other function: scan its arguments
      } else {
        if (!isColorWord(lower)) continue;
        repl = UD.formatColor(UD.transformColor(UD.parseColor(lower), role));
      }
      out += value.slice(last, start) + repl;
      last = end;
    }
    out += value.slice(last);

    if (valueCache.size > 8000) valueCache.clear();
    valueCache.set(key, out);
    return out;
  }

  // ---- custom properties --------------------------------------------------

  const HSL_TRIPLE = /^\s*(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\s*$/;
  const RGB_TRIPLE = /^\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*$/;

  // `--x: 0 0% 100%` / `--x: 255 255 255` are consumed as hsl(var(--x)) / rgb(var(--x)).
  function transformTriple(value, role) {
    let m = HSL_TRIPLE.exec(value);
    if (m) {
      const c = UD.parseColor('hsl(' + value + ')');
      if (!c) return value;
      const t = UD.transformColor(c, role);
      const [h, s, l] = UD.rgbToHsl(t.r, t.g, t.b);
      return +h.toFixed(1) + ' ' + +(s * 100).toFixed(1) + '% ' + +(l * 100).toFixed(1) + '%';
    }
    m = RGB_TRIPLE.exec(value);
    if (m && +m[1] < 256 && +m[2] < 256 && +m[3] < 256) {
      const t = UD.transformColor({ r: +m[1], g: +m[2], b: +m[3], a: 1 }, role);
      return t.r + ' ' + t.g + ' ' + t.b;
    }
    return value;
  }

  function varVariants(name, value) {
    if (!value || /\\/.test(name)) return [];
    const bare = name.slice(2);
    const res = [];
    for (const role of ['bg', 'fg', 'bd']) {
      let nv = transformTriple(value, role);
      if (nv === value) nv = transformValue(value, role);
      if (nv !== value) res.push(['--ud-' + role + '-' + bare, nv]);
    }
    return res;
  }

  // ---- declarations -------------------------------------------------------

  const FG = new Set([
    'color', 'fill', 'stroke', 'caret-color', 'text-decoration', 'text-decoration-color',
    '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke',
    'text-emphasis-color', 'text-emphasis',
  ]);
  const BG = new Set(['background', 'background-color', 'background-image', 'scrollbar-color', 'stop-color', 'flood-color', 'lighting-color']);
  const SH = new Set(['box-shadow', 'text-shadow']);
  const BD = /^(border|outline|column-rule)(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/;

  const roleCache = new Map();
  function roleOf(name) {
    let r = roleCache.get(name);
    if (r === undefined) {
      if (name.startsWith('--')) r = /\\/.test(name) ? null : 'var';
      else if (FG.has(name)) r = 'fg';
      else if (BG.has(name)) r = 'bg';
      else if (SH.has(name)) r = 'sh';
      else if (BD.test(name)) r = 'bd';
      else r = null;
      roleCache.set(name, r);
    }
    return r;
  }

  const usageRole = (role) => (role === 'sh' ? 'bg' : role);

  function processDecls(text) {
    const res = [];
    for (const d of splitDecls(text)) {
      const role = roleOf(d.name);
      if (!role) continue;
      const imp = d.imp ? ' !important' : '';
      if (role === 'var') {
        for (const [n, v] of varVariants(d.name, d.value)) res.push(n + ':' + v + imp);
        continue;
      }
      const nv = transformValue(d.value, usageRole(role));
      if (nv === d.value && role === 'bg' && /url\(/i.test(d.value)) continue; // big images: nothing to gain
      res.push(d.name + ':' + nv + imp);
    }
    return res;
  }

  // ---- rules --------------------------------------------------------------

  const hasType = (n) => typeof globalThis[n] === 'function';

  function processRule(rule) {
    if (rule instanceof CSSStyleRule) {
      const decls = processDecls(rule.style.cssText);
      let nested = '';
      if (rule.cssRules && rule.cssRules.length) nested = processRules(rule.cssRules);
      if (!decls.length && !nested) return '';
      return rule.selectorText + '{' + decls.join(';') + (decls.length && nested ? ';' : '') + nested + '}';
    }
    if (rule instanceof CSSImportRule) {
      let sheet = null;
      try {
        sheet = rule.styleSheet;
        if (sheet) sheet.cssRules; // throws when cross-origin
      } catch (e) {
        return '';
      }
      if (!sheet) return '';
      let inner = processRules(sheet.cssRules);
      if (!inner) return '';
      if (rule.layerName != null) inner = '@layer' + (rule.layerName ? ' ' + rule.layerName : '') + '{' + inner + '}';
      const media = rule.media && rule.media.mediaText;
      if (media && media !== 'all') inner = '@media ' + media + '{' + inner + '}';
      return inner;
    }
    if (hasType('CSSPageRule') && rule instanceof CSSPageRule) return '';
    if (rule instanceof CSSGroupingRule) {
      const inner = processRules(rule.cssRules);
      if (!inner) return '';
      const text = rule.cssText;
      return text.slice(0, text.indexOf('{')).trim() + '{' + inner + '}';
    }
    return '';
  }

  function processRules(list) {
    let out = '';
    for (let i = 0; i < list.length; i++) {
      try {
        out += processRule(list[i]);
      } catch (e) {}
    }
    return out;
  }

  UD.splitDecls = splitDecls;
  UD.roleOf = roleOf;
  UD.usageRole = usageRole;
  UD.transformValue = transformValue;
  UD.varVariants = varVariants;
  UD.processRule = processRule;
  UD.processRules = processRules;
})();
