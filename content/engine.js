// Orchestrator: applies the dark theme, keeps it in sync with the page, and steps
// aside when the site is already dark.
(() => {
  'use strict';
  const UD = globalThis.__UD;
  const docEl = document.documentElement;
  if (!UD || !docEl || globalThis.__udStarted) return;
  if (!(docEl instanceof HTMLHtmlElement)) return;
  if (/pdf/i.test(document.contentType || '')) return;
  globalThis.__udStarted = true;

  const DEFAULTS = { enabled: true, followSystem: true, disabledHosts: [] };
  let settings = { ...DEFAULTS };

  const EARLY_CSS = 'html{color-scheme:dark!important;background-color:#202020}';
  const INVERT_CSS =
    'html{background:#fff!important;filter:invert(1) hue-rotate(180deg) contrast(.8)!important}' +
    'img,picture,video,embed,object,[style*="background-image"]{filter:invert(1) hue-rotate(180deg) contrast(1.25)!important}';

  const makeStyle = (id, css) => {
    const s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    return s;
  };
  const earlyEl = makeStyle('__ud-early', EARLY_CSS);
  const invertEl = makeStyle('__ud-invert', INVERT_CSS);
  const attach = (el) => {
    if (!el.isConnected) (document.documentElement || docEl).appendChild(el);
  };

  // ---- inline styles / presentational attributes --------------------------

  const OURS = new WeakSet(); // constructed sheets we created
  const inlineLog = new Map(); // element -> Map(attr -> {orig, written})

  function writeAttr(el, attr, orig, written) {
    let m = inlineLog.get(el);
    if (!m) inlineLog.set(el, (m = new Map()));
    m.set(attr, { orig, written });
    el.setAttribute(attr, written);
  }

  function logged(el, attr) {
    const m = inlineLog.get(el);
    return m && m.get(attr);
  }

  function processStyleAttr(el) {
    const cur = el.getAttribute('style');
    if (!cur) return;
    const rec = logged(el, 'style');
    if (rec && rec.written === cur) return;
    let changed = false;
    const out = [];
    for (const d of UD.splitDecls(cur)) {
      const role = UD.roleOf(d.name);
      if (role === 'var') {
        out.push(d);
        for (const [n, v] of UD.varVariants(d.name, d.value)) {
          out.push({ name: n, value: v, imp: d.imp });
          changed = true;
        }
        continue;
      }
      if (role) {
        const nv = UD.transformValue(d.value, UD.usageRole(role));
        if (nv !== d.value) {
          changed = true;
          out.push({ name: d.name, value: nv, imp: d.imp });
          continue;
        }
      }
      out.push(d);
    }
    if (!changed) {
      const m = inlineLog.get(el);
      if (m) m.delete('style');
      return;
    }
    writeAttr(el, 'style', cur, out.map((d) => d.name + ':' + d.value + (d.imp ? ' !important' : '')).join(';'));
  }

  const PRES = [
    ['bgcolor', 'bg', null],
    ['fill', 'fg', null],
    ['stroke', 'fg', null],
    ['stop-color', 'bg', null],
    ['flood-color', 'bg', null],
    ['text', 'fg', 'body'],
    ['link', 'fg', 'body'],
    ['vlink', 'fg', 'body'],
    ['alink', 'fg', 'body'],
    ['color', 'fg', 'font'],
  ];
  const PRES_SEL =
    '[bgcolor],[fill],[stroke],[stop-color],[flood-color],body[text],body[link],body[vlink],body[alink],font[color]';

  function processPresAttrs(el) {
    if (!el.hasAttributes || !el.hasAttributes()) return;
    for (const [attr, role, tag] of PRES) {
      if (tag && el.localName !== tag) continue;
      if (!el.hasAttribute(attr)) continue;
      const cur = el.getAttribute(attr);
      const rec = logged(el, attr);
      if (rec && rec.written === cur) continue;
      const nv = UD.transformValue(cur, role);
      if (nv !== cur) writeAttr(el, attr, cur, nv);
    }
  }

  function revertInline(keepLog) {
    for (const [el, m] of inlineLog) {
      for (const [attr, r] of m) {
        if (el.getAttribute(attr) === r.written) el.setAttribute(attr, r.orig);
      }
    }
    if (!keepLog) inlineLog.clear();
  }

  function reapplyInline() {
    for (const [el, m] of inlineLog) {
      for (const [attr, r] of m) {
        if (el.getAttribute(attr) === r.orig) el.setAttribute(attr, r.written);
      }
    }
  }

  // ---- logos: dark ink on transparency is inverted so it stays visible -------

  const imgSheet = new CSSStyleSheet();
  imgSheet.replaceSync('img[data-ud-inv]{filter:invert(1) hue-rotate(180deg)}');
  OURS.add(imgSheet);
  const imgDone = new WeakMap(); // img -> src that was analysed
  const imgResult = new Map(); // src -> boolean

  function checkImg(img) {
    const src = img.currentSrc || img.src;
    if (!src || !img.complete || imgDone.get(img) === src) return;
    const isSvg = /\.svg(\?|#|$)|^data:image\/svg/i.test(src);
    if (!img.naturalWidth && !isSvg) return;
    imgDone.set(img, src);
    const apply = (inv) => {
      if (inv) img.setAttribute('data-ud-inv', '');
      else img.removeAttribute('data-ud-inv');
    };
    if (imgResult.has(src)) return apply(imgResult.get(src));
    if (!isSvg && img.naturalWidth * img.naturalHeight > 360000) return;
    let local = null;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 48;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, 48, 48);
      local = UD.analyzePixels(x.getImageData(0, 0, 48, 48).data);
    } catch (e) {}
    if (local !== null) {
      imgResult.set(src, local);
      apply(local);
      return;
    }
    if (!/^https?:/i.test(src)) return;
    try {
      chrome.runtime.sendMessage({ type: 'img', url: src }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok) return;
        imgResult.set(src, r.inv);
        if (imgDone.get(img) === src) apply(r.inv);
      });
    } catch (e) {}
  }

  // ---- scopes (document + open shadow roots) ------------------------------

  const manager = {
    scopes: new Map(),
    enabled: false,
    syncQueued: false,

    addRoot(root) {
      if (this.scopes.has(root)) return;
      const scope = new Scope(root);
      this.scopes.set(root, scope);
      if (this.enabled) scope.start();
    },
    enable() {
      this.enabled = true;
      for (const s of this.scopes.values()) s.start();
    },
    disable() {
      this.enabled = false;
      for (const s of this.scopes.values()) s.stop();
      revertInline(false);
    },
    suspend() {
      if (!this.enabled) return;
      for (const s of this.scopes.values()) s.setAdopted([]);
      revertInline(true);
      this.flushRecords();
    },
    resume() {
      if (!this.enabled) return;
      reapplyInline();
      for (const s of this.scopes.values()) s.rebuild();
      this.flushRecords();
    },
    flushRecords() {
      for (const s of this.scopes.values()) s.mo.takeRecords();
    },
    markDirty() {
      for (const s of this.scopes.values()) s.markDirty();
    },
    queueSync() {
      if (this.syncQueued || !this.enabled) return;
      this.syncQueued = true;
      requestAnimationFrame(() => {
        this.syncQueued = false;
        for (const s of this.scopes.values()) s.syncSheets();
      });
    },
    gc() {
      for (const [root, s] of this.scopes) {
        if (root !== document && !root.host.isConnected) {
          s.stop();
          this.scopes.delete(root);
        }
      }
      for (const el of inlineLog.keys()) if (!el.isConnected) inlineLog.delete(el);
    },
  };

  function onShadowEvent(e) {
    const host = e.target;
    const sr = host && host.shadowRoot;
    if (sr) manager.addRoot(sr);
  }

  class Scope {
    constructor(root) {
      this.root = root;
      this.recs = new Map(); // source sheet -> {out, count, dirty, pending}
      this.order = [];
      this.active = false;
      this.mo = new MutationObserver((list) => this.onMutations(list));
      root.addEventListener('__ud_s', onShadowEvent, true);
      root.addEventListener('load', (e) => {
        const t = e.target;
        if (!t) return;
        if (t.localName === 'link') manager.queueSync();
        else if (t.localName === 'img') checkImg(t);
      }, true);
    }

    start() {
      if (this.active) return;
      this.active = true;
      this.mo.observe(this.root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'media', 'disabled', 'href', 'rel', 'bgcolor', 'fill', 'stroke', 'stop-color', 'flood-color', 'text', 'link', 'vlink', 'alink', 'color', 'src', 'srcset'],
      });
      this.syncSheets();
      this.processSubtree(this.root === document ? document.documentElement : this.root);
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      this.mo.disconnect();
      this.setAdopted([]);
    }

    markDirty() {
      for (const rec of this.recs.values()) rec.dirty = true;
      if (this.active) manager.queueSync();
    }

    processSubtree(node) {
      if (!node) return;
      if (node.nodeType === 1) {
        if (node.hasAttribute('style')) processStyleAttr(node);
        processPresAttrs(node);
        if (node.localName === 'img') checkImg(node);
        if (node.shadowRoot) manager.addRoot(node.shadowRoot);
      }
      if (!node.querySelectorAll) return;
      for (const el of node.querySelectorAll('[style]')) processStyleAttr(el);
      for (const el of node.querySelectorAll(PRES_SEL)) processPresAttrs(el);
      for (const el of node.querySelectorAll('img')) checkImg(el);
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) manager.addRoot(el.shadowRoot);
    }

    onMutations(list) {
      if (!this.active) return;
      let sheets = false;
      for (const m of list) {
        if (m.type === 'attributes') {
          const t = m.target;
          if (m.attributeName === 'style') processStyleAttr(t);
          else if (m.attributeName === 'src' || m.attributeName === 'srcset') {
            if (t.localName === 'img') checkImg(t);
          }
          else if (t.localName === 'link' || t.localName === 'style') sheets = true;
          else processPresAttrs(t);
        } else if (m.type === 'characterData') {
          const p = m.target.parentNode;
          if (p && p.localName === 'style') sheets = true;
        } else {
          if (m.target.localName === 'style') sheets = true;
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.localName === 'style' || n.localName === 'link' || (n.querySelector && n.querySelector('style,link'))) sheets = true;
            this.processSubtree(n);
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && (n.localName === 'style' || n.localName === 'link' || (n.querySelector && n.querySelector('style,link')))) sheets = true;
          }
        }
      }
      if (sheets) this.syncSheets();
    }

    rulesOf(sheet) {
      try {
        return sheet.cssRules;
      } catch (e) {
        return null;
      }
    }

    build(sheet, rules) {
      let text = UD.processRules(rules);
      const media = sheet.media ? sheet.media.mediaText : '';
      if (media && media !== 'all' && text) text = '@media ' + media + '{' + text + '}';
      return text;
    }

    ensure(sheet) {
      let rec = this.recs.get(sheet);
      const rules = this.rulesOf(sheet);
      if (!rules) {
        if (!rec) {
          rec = { out: null, count: 0, dirty: false, pending: false };
          this.recs.set(sheet, rec);
        }
        if (!rec.out && !rec.pending && !rec.failed) this.fetchOutside(sheet, rec);
        return;
      }
      if (!rec) {
        const out = new CSSStyleSheet();
        OURS.add(out);
        rec = { out, count: 0, dirty: true, pending: false };
        this.recs.set(sheet, rec);
      }
      if (!rec.out) return;
      const len = rules.length;
      const media = sheet.media ? sheet.media.mediaText : '';
      if (rec.dirty || len < rec.count || (media && len !== rec.count)) {
        try {
          rec.out.replaceSync(this.build(sheet, rules));
        } catch (e) {}
        rec.count = len;
        rec.dirty = false;
      } else if (len > rec.count) {
        for (let i = rec.count; i < len; i++) {
          const t = UD.processRule(rules[i]);
          if (t) {
            try {
              rec.out.insertRule(t, rec.out.cssRules.length);
            } catch (e) {}
          }
        }
        rec.count = len;
      }
    }

    fetchOutside(sheet, rec) {
      const href = sheet.href;
      if (!href) {
        rec.failed = true;
        return;
      }
      rec.pending = true;
      try {
        chrome.runtime.sendMessage({ type: 'css', url: href }, (resp) => {
          void chrome.runtime.lastError;
          rec.pending = false;
          if (!resp || !resp.ok) {
            rec.failed = true;
            return;
          }
          try {
            const tmp = new CSSStyleSheet();
            tmp.replaceSync(resp.text);
            const out = new CSSStyleSheet();
            OURS.add(out);
            out.replaceSync(this.build(sheet, tmp.cssRules));
            rec.out = out;
            this.rebuild();
          } catch (e) {
            rec.failed = true;
          }
        });
      } catch (e) {
        rec.pending = false;
        rec.failed = true;
      }
    }

    syncSheets() {
      if (!this.active) return;
      const adopted = Array.from(this.root.adoptedStyleSheets).filter((s) => !OURS.has(s));
      const all = Array.from(this.root.styleSheets).concat(adopted).filter((s) => !s.disabled);
      const seen = new Set(all);
      for (const s of this.recs.keys()) if (!seen.has(s)) this.recs.delete(s);
      for (const s of all) this.ensure(s);
      this.order = all;
      this.rebuild();
    }

    rebuild() {
      if (!this.active) return;
      const ours = [];
      for (const s of this.order) {
        const rec = this.recs.get(s);
        if (rec && rec.out) ours.push(rec.out);
      }
      ours.push(imgSheet);
      this.setAdopted(ours);
    }

    setAdopted(ours) {
      const cur = Array.from(this.root.adoptedStyleSheets);
      const next = cur.filter((s) => !OURS.has(s)).concat(ours);
      if (next.length === cur.length && next.every((s, i) => s === cur[i])) return;
      try {
        this.root.adoptedStyleSheets = next;
      } catch (e) {}
    }
  }

  // ---- state machine ------------------------------------------------------

  let state = 'boot'; // boot | engine | invert | native | off
  const darkMq = matchMedia('(prefers-color-scheme: dark)');

  function shouldRun() {
    if (!settings.enabled) return false;
    if (settings.disabledHosts.includes(location.hostname)) return false;
    if (settings.followSystem && !darkMq.matches) return false;
    return true;
  }

  function setState(next) {
    if (next === state) return;
    state = next;
    if (next === 'engine') attach(earlyEl);
    else earlyEl.remove();
    if (next === 'invert') attach(invertEl);
    else invertEl.remove();
    if (next === 'engine') manager.enable();
    else manager.disable();
  }

  // Run fn with every trace of our styling removed (no paint can happen in between).
  function withEngineOff(fn) {
    const hadEarly = earlyEl.isConnected;
    const hadInvert = invertEl.isConnected;
    earlyEl.remove();
    invertEl.remove();
    manager.suspend();
    try {
      return fn();
    } finally {
      if (hadEarly) attach(earlyEl);
      if (hadInvert) attach(invertEl);
      manager.resume();
    }
  }

  let watchedBody = null;
  const attrMo = new MutationObserver(() => schedule(250));
  function watchRoots() {
    attrMo.observe(docEl, { attributes: true });
    if (document.body && document.body !== watchedBody) {
      watchedBody = document.body;
      attrMo.observe(document.body, { attributes: true });
    }
  }

  function evaluate() {
    if (!shouldRun()) {
      setState('off');
      return;
    }
    if (state === 'boot' || state === 'off') setState('engine');
    if (!document.body) return;
    watchRoots();

    const native = withEngineOff(() => UD.measure());
    if (UD.isDarkPage(native)) {
      setState('native');
    } else {
      if (state === 'native') setState('engine');
      if (state === 'engine' && document.readyState === 'complete') {
        const after = UD.measure();
        if (UD.isLightPage(after)) setState('invert');
      }
    }
    attrMo.takeRecords();
    manager.flushRecords();
  }

  let timer = 0;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(evaluate, delay);
  }

  // ---- boot ---------------------------------------------------------------

  manager.addRoot(document);
  document.addEventListener('__ud_i', () => manager.queueSync(), true);
  document.addEventListener('__ud_r', () => manager.markDirty(), true);

  if (shouldRun()) setState('engine');

  const applySettings = (s) => {
    settings = { ...DEFAULTS, ...s };
    schedule(0);
  };
  try {
    chrome.storage.local.get(DEFAULTS, applySettings);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !Object.keys(DEFAULTS).some((k) => changes[k])) return;
      const next = { ...settings };
      for (const k of Object.keys(DEFAULTS)) if (changes[k]) next[k] = changes[k].newValue === undefined ? DEFAULTS[k] : changes[k].newValue;
      applySettings(next);
    });
  } catch (e) {}

  darkMq.addEventListener('change', () => schedule(0));
  document.addEventListener('DOMContentLoaded', () => {
    const scope = manager.scopes.get(document);
    if (scope && scope.active) scope.processSubtree(document.documentElement);
    schedule(0);
  });
  window.addEventListener('load', () => {
    schedule(0);
    setTimeout(() => schedule(0), 1500);
  });

  setInterval(() => {
    manager.gc();
    if (state === 'engine') for (const s of manager.scopes.values()) s.rebuild();
  }, 3000);
})();
