// Runs in the page's MAIN world. Reports CSSOM edits and shadow roots to the
// isolated-world engine through DOM events (the only channel shared by both worlds).
(() => {
  'use strict';
  if (window.__udHook) return;
  window.__udHook = true;

  let pendingInsert = false;
  let pendingReplace = false;
  const fire = (kind) => {
    if (kind === 'i') {
      if (pendingInsert) return;
      pendingInsert = true;
      queueMicrotask(() => {
        pendingInsert = false;
        document.dispatchEvent(new Event('__ud_i'));
      });
    } else {
      if (pendingReplace) return;
      pendingReplace = true;
      queueMicrotask(() => {
        pendingReplace = false;
        document.dispatchEvent(new Event('__ud_r'));
      });
    }
  };

  const wrap = (proto, name, kind) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      const res = orig.apply(this, args);
      fire(kind);
      if (name === 'replace' && res && typeof res.then === 'function') res.then(() => fire('r'), () => {});
      return res;
    };
  };

  const sheet = window.CSSStyleSheet && CSSStyleSheet.prototype;
  wrap(sheet, 'insertRule', 'i');
  wrap(sheet, 'addRule', 'i');
  wrap(sheet, 'deleteRule', 'r');
  wrap(sheet, 'removeRule', 'r');
  wrap(sheet, 'replace', 'r');
  wrap(sheet, 'replaceSync', 'r');
  if (window.CSSGroupingRule) {
    wrap(CSSGroupingRule.prototype, 'insertRule', 'r');
    wrap(CSSGroupingRule.prototype, 'deleteRule', 'r');
  }

  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, init);
    try {
      this.dispatchEvent(new Event('__ud_s'));
    } catch (e) {}
    return root;
  };
})();
