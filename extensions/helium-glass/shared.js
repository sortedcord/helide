(() => {
  "use strict";
  const DEFAULTS = { enabled: true, transparency: 65, protectContrast: true, sites: {} };
  function normalize(value = {}) {
    if (!value || typeof value !== "object") value = {};
    const amount = Number(value.transparency);
    return {
      enabled: value.enabled !== false,
      transparency: Number.isFinite(amount) ? Math.max(0, Math.min(100, amount)) : DEFAULTS.transparency,
      protectContrast: value.protectContrast !== false,
      sites: value.sites && typeof value.sites === "object" && !Array.isArray(value.sites) ? value.sites : {}
    };
  }
  function siteKey(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "file:" ? "file://" : /https?:/.test(parsed.protocol) ? parsed.host : null;
    } catch { return null; }
  }
  function isEnabled(settings, site) {
    return Boolean(settings.enabled && settings.transparency > 0 && settings.sites[site] !== false);
  }
  globalThis.HeliumGlassSettings = { DEFAULTS, normalize, siteKey, isEnabled };
})();
