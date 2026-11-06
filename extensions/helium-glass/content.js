(() => {
  "use strict";
  if (globalThis.__heliumGlass) return;
  globalThis.__heliumGlass = true;
  const S = HeliumGlassSettings, P = HeliumGlassPalette, C = HeliumGlassCache;
  const ATTRIBUTE = "data-helium-glass-surface";
  const prefix = "hg" + Math.random().toString(36).slice(2, 12);
  const exempt = "head,script,style,link,meta,noscript,template,a,[role=link],[contenteditable=true],svg,canvas,video,audio,picture,img,iframe,object,embed,input,textarea,select,option,button,[role=button],[role=img],[role=slider],[role=checkbox],[role=switch],[role=alert]";
  const styled = new Set(), originalMarkers = new WeakMap(), groups = new Map(), colors = new Map();
  const canvases = new Map();
  const startup = { startedAt: performance.now(), cacheHit: false, bootstrapAt: null, firstStyleAt: null };
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let settings = S.normalize(), settingsRevision = 0, site = S.siteKey(location.href);
  let theme = P.inferTheme([], matchMedia("(prefers-color-scheme: dark)").matches);
  let appliedCss = "", bootstrapCss = "", cssChain = Promise.resolve(), flushTimer, scanTimer, cacheTimer, scanToken = 0;
  let bootstrapSelectors = [];
  let criticalQueued = false, lastCritical = -Infinity;
  let running = false, ready = false, pendingRoots = new Set(), lastThemeCheck = 0, error = null;
  function parseColor(text) {
    if (!text || text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    if (colors.has(text)) return colors.get(text);
    if (!CSS.supports("color", text)) return null;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = text; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const result = { r, g, b, a: a / 255 };
    if (colors.size > 1000) colors.clear();
    colors.set(text, result); return result;
  }
  function enabled() { return ready && S.isEnabled(settings, site); }
  function snapshots(elements) {
    // Backgrounds do not inherit. Temporarily remove only our markers, measure
    // original styles in one batch, then restore them before the browser paints.
    const markers = elements.map(element => element.getAttribute(ATTRIBUTE));
    const root = document.documentElement, measuring = root?.getAttribute(C.MEASURING);
    root?.setAttribute(C.MEASURING, "");
    elements.forEach(element => element.removeAttribute(ATTRIBUTE));
    try {
      return elements.map(element => {
        const style = getComputedStyle(element);
        const background = parseColor(style.backgroundColor);
        const image = style.backgroundImage;
        const rect = background?.a > 0.03 || /gradient\(/.test(image) ? element.getBoundingClientRect() : null;
        return { element, background, image, foreground: parseColor(style.color),
          display: style.display, visibility: style.visibility, position: style.position,
          z: Number(style.zIndex), rect, role: element.getAttribute("role") };
      });
    } finally {
      elements.forEach((element, i) => { if (markers[i] !== null) element.setAttribute(ATTRIBUTE, markers[i]); });
      if (root) { if (measuring == null) root.removeAttribute(C.MEASURING); else root.setAttribute(C.MEASURING, measuring); }
    }
  }
  function detectTheme() {
    const candidates = new Set([document.documentElement, document.body].filter(Boolean));
    for (const x of [0.2, 0.5, 0.8]) for (const y of [0.2, 0.5, 0.8]) {
      let element = document.elementFromPoint(innerWidth * x, innerHeight * y);
      for (let depth = 0; element && depth < 12; element = element.parentElement, depth++) candidates.add(element);
    }
    const list = [...candidates];
    const map = new Map(snapshots(list).map(sample => [sample.element,
      sample.background?.a >= 0.8 ? sample.background : P.gradient(sample.image, parseColor)?.color]));
    const samples = [];
    for (const x of [0.2, 0.5, 0.8]) for (const y of [0.2, 0.5, 0.8]) {
      for (let element = document.elementFromPoint(innerWidth * x, innerHeight * y); element; element = element.parentElement) {
        const color = map.get(element);
        if (color?.a >= 0.8) { samples.push(color); break; }
      }
    }
    theme = P.inferTheme(samples, matchMedia("(prefers-color-scheme: dark)").matches);
    lastThemeCheck = performance.now();
    return list;
  }
  function mark(element, declarations) {
    const key = declarations.join(";");
    if (!groups.has(key)) {
      if (groups.size >= 1000) { restore(element); return; }
      groups.set(key, `${prefix}-${groups.size}`);
    }
    if (!originalMarkers.has(element)) originalMarkers.set(element, element.getAttribute(ATTRIBUTE));
    element.setAttribute(ATTRIBUTE, groups.get(key)); styled.add(element);
  }
  function restore(element) {
    if (!styled.has(element)) return;
    const previous = originalMarkers.get(element);
    if (previous == null) element.removeAttribute(ATTRIBUTE); else element.setAttribute(ATTRIBUTE, previous);
    styled.delete(element);
  }
  function analyze(sample) {
    const { element, rect } = sample;
    if (sample.display === "none" || sample.visibility === "hidden" || element.matches(exempt) || !rect || !rect.width || !rect.height) { restore(element); return; }
    const root = element === document.documentElement || element === document.body;
    const large = rect.width >= innerWidth * 0.55 && rect.width * rect.height >= innerWidth * innerHeight * 0.25;
    const elevated = sample.role === "dialog" || element.tagName === "DIALOG" || ((sample.position === "fixed" || sample.position === "sticky") && sample.z > 1);
    const gradient = P.gradient(sample.image, parseColor);
    let color = sample.background;
    if ((!color || color.a < 0.04) && gradient) color = gradient.color;
    const treatment = P.surface(color, sample.foreground, { root, large, elevated }, theme, settings);
    const selector = root ? element.localName : /^#[a-z_][\w-]{0,95}$/i.test("#" + element.id) ? "#" + element.id : element.localName === "main" ? "main" : null;
    if (selector) {
      if (treatment?.kind === "base" && sample.image === "none" && (root || document.querySelectorAll(selector).length === 1) && (canvases.has(selector) || canvases.size < C.MAX_SURFACES)) {
        canvases.set(selector, { selector, color: { ...sample.background } });
      } else canvases.delete(selector);
    }
    if (!treatment) { restore(element); return; }
    const background = sample.background || { r: 0, g: 0, b: 0, a: 0 };
    const declarations = [`background-color:${P.css({ ...background, a: background.a * treatment.a / color.a })}!important`];
    if (gradient && gradient.colors.every(stop => P.saturation(stop) <= 0.32 || P.distance(stop, theme.base) <= 0.2)) {
      declarations.push(`background-image:${gradient.recolor(treatment.a / color.a)}!important`);
    }
    mark(element, declarations);
  }
  function flush() {
    flushTimer = undefined;
    const active = new Set();
    for (const element of styled) {
      if (!element.isConnected) { styled.delete(element); continue; }
      active.add(element.getAttribute(ATTRIBUTE));
    }
    const css = enabled() ? [...groups].filter(([, id]) => active.has(id)).map(([declarations, id]) => `[${ATTRIBUTE}="${id}"]{${declarations}}`).join("\n") : "";
    cssChain = cssChain.then(async () => {
      if (css === appliedCss) return;
      const response = await chrome.runtime.sendMessage({ type: "HELIUM_GLASS_CSS", css, previousCss: appliedCss });
      if (!response?.ok) throw new Error(response?.error || "Could not apply styles");
      appliedCss = css; error = null;
      if (css && startup.firstStyleAt === null) startup.firstStyleAt = performance.now();
    }).catch(reason => { error = reason.message; });
  }
  function flushSoon(delay = 16) {
    // Throttle instead of debounce: a long scan must not postpone every update.
    if (flushTimer !== undefined) { if (delay !== 0) return; clearTimeout(flushTimer); }
    if (delay === 0) flush(); else flushTimer = setTimeout(flush, delay);
  }
  function dropBootstrap() {
    if (!bootstrapCss) return;
    const previousCss = bootstrapCss; bootstrapCss = "";
    cssChain = cssChain.then(async () => {
      const response = await chrome.runtime.sendMessage({ type: "HELIUM_GLASS_CSS", css: "", previousCss });
      if (!response?.ok) throw new Error(response?.error || "Could not remove cached styles");
    }).catch(reason => { error = reason.message; });
  }
  function saveCacheSoon() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      if (!enabled() || document.readyState === "loading" || !document.body) return;
      const entry = { version: C.VERSION, time: Date.now(), mediaDark: matchMedia("(prefers-color-scheme: dark)").matches,
        html: C.attributes(document.documentElement), body: C.attributes(document.body),
        surfaces: [...canvases.values()].filter(surface => document.querySelector(surface.selector)) };
      chrome.runtime.sendMessage({ type: "HELIUM_GLASS_CACHE", entry }).catch(reason => { error = reason.message; });
    }, 500);
  }
  function critical() {
    if (!enabled() || !document.documentElement || document.hidden) return;
    lastCritical = performance.now();
    const candidates = detectTheme().slice(0, 64).filter(element => !element.closest(exempt));
    for (const sample of snapshots(candidates)) analyze(sample);
    flushSoon(0);
  }
  function queueCritical() {
    if (criticalQueued || !enabled()) return;
    criticalQueued = true;
    queueMicrotask(() => { criticalQueued = false; critical(); });
  }
  const idle = callback => typeof requestIdleCallback === "function" ? requestIdleCallback(callback, { timeout: 50 }) : setTimeout(() => callback({ timeRemaining: () => 8 }), 16);
  function beginScan() {
    if (running || !enabled() || document.visibilityState === "hidden") return;
    running = true;
    const token = scanToken;
    const roots = [...pendingRoots]; pendingRoots.clear();
    if (roots.includes(document.documentElement) || performance.now() - lastThemeCheck > 500 || !styled.size) detectTheme();
    let rootIndex = 0, walker = null, first = null, count = 0;
    function step(deadline) {
      if (token !== scanToken) return;
      if (!enabled()) { running = false; return; }
      const batch = [], started = performance.now();
      while (batch.length < 100 && count < 8000) {
        if (!walker) {
          const root = roots[rootIndex++];
          if (!root) break;
          if (!root.isConnected || root.closest(exempt)) continue;
          walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, { acceptNode: element => element.matches(exempt) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
          first = root;
        }
        const next = first || walker.nextNode(); first = null;
        if (!next) { walker = null; continue; }
        batch.push(next); count++;
        if (performance.now() - started > 8 || deadline.timeRemaining() < 1) break;
      }
      for (const sample of snapshots(batch)) analyze(sample);
      flushSoon();
      if ((walker || rootIndex < roots.length) && count < 8000) idle(step);
      else {
        running = false;
        const bootstrapReady = bootstrapCss && document.body && roots.includes(document.documentElement) && bootstrapSelectors.every(selector => document.querySelector(selector));
        if (bootstrapReady || document.readyState !== "loading") { flushSoon(0); dropBootstrap(); }
        if (document.readyState !== "loading") saveCacheSoon();
        if (pendingRoots.size) idle(beginScan);
      }
    }
    idle(step);
  }
  function schedule(root = document.documentElement, urgent = false) {
    if (!root || !enabled()) return;
    // A broad theme update subsumes queued subtrees.
    if (root === document.documentElement) pendingRoots = new Set([root]);
    else if (!pendingRoots.has(document.documentElement) && pendingRoots.size < 30) pendingRoots.add(root);
    if (scanTimer !== undefined) { if (!urgent) return; clearTimeout(scanTimer); }
    scanTimer = setTimeout(() => { scanTimer = undefined; beginScan(); }, urgent ? 0 : 50);
  }
  function clear() {
    scanToken++; running = false; pendingRoots.clear(); clearTimeout(scanTimer); scanTimer = undefined;
    clearTimeout(cacheTimer); canvases.clear(); dropBootstrap();
    for (const element of [...styled]) restore(element);
    flushSoon(0);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") {
        const rootChange = record.target === document.documentElement || record.target === document.body || /theme|color/.test(record.attributeName);
        if (rootChange) { queueCritical(); schedule(); break; }
        schedule(record.target);
      } else {
        // A new stylesheet can change existing surfaces, not only new nodes.
        if ([...record.addedNodes].some(node => node.nodeType === 1 && (node.matches("style,link[rel=stylesheet]") || node.querySelector("style,link[rel=stylesheet]")))) { queueCritical(); schedule(); break; }
        if (record.target.nodeType === 1 && record.target.matches("style")) { queueCritical(); schedule(); break; }
        if (document.readyState === "loading" && performance.now() - lastCritical > 50) queueCritical();
        if (record.removedNodes.length) flushSoon();
        for (const node of record.addedNodes) if (node.nodeType === 1) schedule(node);
      }
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-color-scheme", "color-scheme", "aria-hidden", "open"] });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    settingsRevision++;
    settings = S.normalize(changes.settings.newValue);
    clear(); if (enabled()) { critical(); schedule(document.documentElement, true); }
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "HELIUM_GLASS_STATUS") respond({ enabled: enabled(), mode: theme.mode, tint: P.css(theme.base), surfaces: styled.size, error, startup });
    else if (message?.type === "HELIUM_GLASS_RESCAN") { schedule(); respond({ ok: true }); }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => schedule());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  addEventListener("pageshow", () => schedule());
  addEventListener("resize", () => schedule(), { passive: true });
  document.addEventListener("DOMContentLoaded", () => { critical(); schedule(document.documentElement, true); }, { once: true });
  document.addEventListener("load", event => {
    if (event.target.matches?.("link[rel=stylesheet]")) { queueCritical(); schedule(); }
  }, true);
  chrome.runtime.sendMessage({ type: "HELIUM_GLASS_CONTEXT", mediaDark: matchMedia("(prefers-color-scheme: dark)").matches }).then(context => {
    if (!context?.ok) throw new Error(context?.error || "Could not initialize styles");
    if (!settingsRevision) settings = S.normalize(context.settings);
    site = context?.site || site; // A site's toggle also covers its embedded frames.
    ready = true;
    bootstrapCss = context.bootstrapCss || "";
    bootstrapSelectors = context.bootstrapSelectors || [];
    startup.cacheHit = Boolean(bootstrapCss);
    if (bootstrapCss) startup.bootstrapAt = performance.now();
    if (enabled()) { critical(); schedule(document.documentElement, true); }
    else dropBootstrap();
  }).catch(reason => { error = reason.message; });
})();
