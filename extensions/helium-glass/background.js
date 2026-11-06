"use strict";
importScripts("shared.js");
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (message?.type === "HELIUM_GLASS_CONTEXT") {
    respond({ site: HeliumGlassSettings.siteKey(sender.tab.url) });
    return false;
  }
  if (message?.type !== "HELIUM_GLASS_CSS") return false;
  (async () => {
    const { css, previousCss } = message;
    if (typeof css !== "string" || typeof previousCss !== "string" || css.length > 600000 || previousCss.length > 600000) throw new Error("Invalid stylesheet");
    const target = sender.documentId ? { tabId: sender.tab.id, documentIds: [sender.documentId] } : { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
    // USER origin also handles a page's inline !important fills and bypasses
    // page CSP. Target the exact document so navigation cannot style its successor.
    if (css && css !== previousCss) await chrome.scripting.insertCSS({ target, css, origin: "USER" });
    if (previousCss && css !== previousCss) await chrome.scripting.removeCSS({ target, css: previousCss, origin: "USER" });
    return { ok: true };
  })().then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
