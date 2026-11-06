"use strict";
const S = HeliumGlassSettings;
const $ = id => document.getElementById(id);
let settings, tab, site, saveTimer;
function report(error) { $("error").hidden = false; $("error").textContent = error.message || String(error); }
async function save() {
  try { await chrome.storage.local.set({ settings }); $("error").hidden = true; setTimeout(status, 500); }
  catch (error) { report(error); }
}
async function status() {
  if (!site) return;
  try {
    const state = await chrome.tabs.sendMessage(tab.id, { type: "HELIUM_GLASS_STATUS" }, { frameId: 0 });
    $("status").dataset.off = String(!state.enabled);
    $("status").textContent = state.enabled ? `${state.mode === "dark" ? "Dark" : "Light"} palette · ${state.surfaces} surfaces softened` : "Original website styles are active";
    if (state.error) report(state.error);
  } catch {
    $("status").textContent = "Reload this page to activate Helium Glass";
    $("status").dataset.off = "true";
  }
}
(async () => {
  try {
    const stored = await chrome.storage.local.get("settings"); settings = S.normalize(stored.settings);
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    site = S.siteKey(tab?.url);
    if (tab?.url?.startsWith("https://chromewebstore.google.com/") || tab?.url?.startsWith("https://chrome.google.com/webstore")) site = null;
    $("siteName").textContent = site || "Browser page";
    $("globalToggle").checked = settings.enabled;
    $("siteToggle").checked = site ? settings.sites[site] !== false : false;
    $("siteToggle").disabled = !site;
    $("rescan").disabled = !site;
    $("transparency").value = settings.transparency;
    $("amount").textContent = settings.transparency + "%";
    $("protectContrast").checked = settings.protectContrast;
    $("globalToggle").addEventListener("change", event => { settings.enabled = event.target.checked; save(); });
    $("siteToggle").addEventListener("change", event => { settings.sites = { ...settings.sites, [site]: event.target.checked }; save(); });
    $("transparency").addEventListener("input", event => {
      settings.transparency = Number(event.target.value); $("amount").textContent = settings.transparency + "%";
      clearTimeout(saveTimer); saveTimer = setTimeout(save, 160);
    });
    $("transparency").addEventListener("change", () => { clearTimeout(saveTimer); save(); });
    $("protectContrast").addEventListener("change", event => { settings.protectContrast = event.target.checked; save(); });
    $("rescan").addEventListener("click", async () => {
      try { await chrome.tabs.sendMessage(tab.id, { type: "HELIUM_GLASS_RESCAN" }, { frameId: 0 }); setTimeout(status, 700); }
      catch (error) { report(error); }
    });
    if (site) { status(); setInterval(status, 1500); }
    else { $("status").textContent = "Extensions cannot style this browser page"; $("status").dataset.off = "true"; }
  } catch (error) { report(error); }
})();
