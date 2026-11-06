"use strict";
importScripts("shared.js", "cache.js");
const S = HeliumGlassSettings, C = HeliumGlassCache;
let settings = S.normalize(), entries = {}, writes = Promise.resolve();
const loaded = chrome.storage.local.get(["settings", "surfaceCache"]).then(value => {
  settings = S.normalize(value.settings); entries = C.prune(value.surfaceCache);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) settings = S.normalize(changes.settings.newValue);
});
async function cacheKey(url) {
  const key = C.pageKey(url);
  if (!key) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function targetFor(sender) {
  return sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (!["HELIUM_GLASS_CONTEXT", "HELIUM_GLASS_CACHE", "HELIUM_GLASS_CSS"].includes(message?.type)) return false;
  (async () => {
    const target = targetFor(sender);
    if (message.type !== "HELIUM_GLASS_CSS") {
      await loaded;
      const site = S.siteKey(sender.tab.url), key = sender.tab.incognito ? null : await cacheKey(sender.url);
      if (message.type === "HELIUM_GLASS_CONTEXT") {
        const bootstrapCss = key && S.isEnabled(settings, site) ? C.css(entries[key], settings, message.mediaDark) : "";
        if (bootstrapCss) await chrome.scripting.insertCSS({ target, css: bootstrapCss, origin: "USER" });
        return { ok: true, site, settings, bootstrapCss, bootstrapSelectors: bootstrapCss ? entries[key].surfaces.map(surface => surface.selector) : [] };
      }
      if (key && S.isEnabled(settings, site) && C.valid(message.entry)) {
        const previous = entries[key], entry = message.entry;
        // Identical rescans do not keep writing to disk. Refresh the age daily.
        if (!previous || Date.now() - previous.time > 86400000 || JSON.stringify({ ...previous, time: 0 }) !== JSON.stringify({ ...entry, time: 0 })) {
          entries = C.prune({ ...entries, [key]: entry });
          const snapshot = entries;
          writes = writes.catch(() => {}).then(() => chrome.storage.local.set({ surfaceCache: snapshot }));
          await writes;
        }
      }
      return { ok: true };
    }
    const { css, previousCss } = message;
    if (typeof css !== "string" || typeof previousCss !== "string" || css.length > 600000 || previousCss.length > 600000) throw new Error("Invalid stylesheet");
    // USER origin also handles a page's inline !important fills and bypasses
    // page CSP. Target the exact document so navigation cannot style its successor.
    if (css && css !== previousCss) await chrome.scripting.insertCSS({ target, css, origin: "USER" });
    if (previousCss && css !== previousCss) await chrome.scripting.removeCSS({ target, css: previousCss, origin: "USER" });
    return { ok: true };
  })().then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
