(() => {
  "use strict";
  const VERSION = 1, MAX_PAGES = 64, MAX_SURFACES = 24, MAX_AGE = 7 * 86400000;
  const MEASURING = "data-helium-glass-measuring";
  const ATTRIBUTES = ["class", "data-theme", "data-color-mode", "data-color-scheme", "color-scheme"];
  function pageKey(url) {
    try {
      const value = new URL(url);
      return /^(https?:|file:)$/.test(value.protocol) ? (value.protocol === "file:" ? "file://" : value.origin) + value.pathname : null;
    } catch { return null; }
  }
  function allowedSelector(value) { return typeof value === "string" && /^(html|body|main|#[a-z_][\w-]{0,95})$/i.test(value); }
  function attributes(element) {
    return Object.fromEntries(ATTRIBUTES.map(name => [name, element?.getAttribute(name) ?? null]));
  }
  function validAttributes(value) {
    return value && ATTRIBUTES.every(name => value[name] === null || (typeof value[name] === "string" && value[name].length <= 1024));
  }
  function validColor(color) {
    return color && ["r", "g", "b", "a"].every(key => Number.isFinite(color[key]) && color[key] >= 0 && color[key] <= (key === "a" ? 1 : 255));
  }
  function valid(entry, now = Date.now()) {
    return entry?.version === VERSION && Number.isFinite(entry.time) && entry.time <= now && now - entry.time < MAX_AGE &&
      typeof entry.mediaDark === "boolean" && validAttributes(entry.html) && validAttributes(entry.body) &&
      Array.isArray(entry.surfaces) && entry.surfaces.length <= MAX_SURFACES &&
      entry.surfaces.every(surface => allowedSelector(surface.selector) && validColor(surface.color));
  }
  function quote(value) { return '"' + value.replace(/["\\\n\r\f]/g, char => "\\" + char.charCodeAt(0).toString(16) + " ") + '"'; }
  function guard(values) {
    return ATTRIBUTES.map(name => values[name] === null ? `:not([${name}])` : `[${name}=${quote(values[name])}]`).join("");
  }
  function css(entry, settings, mediaDark, now = Date.now()) {
    if (!valid(entry, now) || entry.mediaDark !== mediaDark || !settings.enabled || settings.transparency <= 0) return "";
    // Theme/class guards stop a previous light theme from tinting a dark reload.
    // The measuring flag disables this entire sheet for original-style reads.
    const root = `html${guard(entry.html)}:has(>body${guard(entry.body)}):not([${MEASURING}])`;
    const factor = (1 - Math.max(0, Math.min(100, settings.transparency)) / 100) ** 3;
    return entry.surfaces.map(({ selector, color }) => {
      const target = selector === "html" ? root : `${root} ${selector}`;
      const alpha = Math.round(color.a * factor * 1000) / 1000;
      return `${target}{background-color:rgba(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)},${alpha})!important}`;
    }).join("\n");
  }
  function prune(entries, now = Date.now()) {
    return Object.fromEntries(Object.entries(entries || {}).filter(([key, value]) => /^[a-f0-9]{64}$/.test(key) && valid(value, now))
      .sort((a, b) => b[1].time - a[1].time).slice(0, MAX_PAGES));
  }
  const api = { VERSION, MAX_PAGES, MAX_SURFACES, MAX_AGE, MEASURING, pageKey, allowedSelector, attributes, valid, css, prune };
  globalThis.HeliumGlassCache = api;
  if (typeof module !== "undefined") module.exports = api;
})();
