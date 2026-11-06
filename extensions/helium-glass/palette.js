(() => {
  "use strict";
  const clamp = (v, low = 0, high = 1) => Math.max(low, Math.min(high, v));
  function luminance(color) {
    const linear = [color.r, color.g, color.b].map(v => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function saturation(c) {
    const high = Math.max(c.r, c.g, c.b), low = Math.min(c.r, c.g, c.b);
    return high === 0 ? 0 : (high - low) / high;
  }
  function distance(a, b) {
    return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) / (255 * Math.sqrt(3));
  }
  function composite(c, alpha, backdrop) {
    return { r: c.r * alpha + backdrop * (1 - alpha), g: c.g * alpha + backdrop * (1 - alpha), b: c.b * alpha + backdrop * (1 - alpha) };
  }
  function inferTheme(samples, prefersDark) {
    const colors = new Map();
    for (const c of samples.filter(c => c && c.a >= 0.8)) {
      const key = [c.r, c.g, c.b].map(v => Math.round(v / 16)).join(",");
      const entry = colors.get(key) || { color: c, count: 0 };
      entry.count += 1;
      colors.set(key, entry);
    }
    const best = [...colors.values()].sort((a, b) => b.count - a.count)[0];
    const base = best?.color || (prefersDark ? { r: 24, g: 26, b: 31, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
    return { base, mode: luminance(base) < 0.35 ? "dark" : "light" };
  }
  function surface(color, foreground, info, theme, settings) {
    if (!color || color.a < 0.04 || info.protected) return null;
    // Leave status/brand colors alone unless they are the page's own base tint.
    if (saturation(color) > 0.32 && distance(color, theme.base) > 0.2) return null;
    const t = clamp(settings.transparency / 100);
    const base = info.root || (info.large && distance(color, theme.base) < 0.15);
    let factor = base ? (1 - t) ** 3 : info.elevated ? 0.98 - t * 0.16 : 0.92 - t * 0.55;
    let alpha = color.a * factor;
    // Protect cards against both a black and a white desktop backdrop. Clear
    // page canvases are intentionally exempt, otherwise they could never clear.
    if (settings.protectContrast && !base && foreground?.a >= 0.8 && contrast(foreground, color) >= 4.5) {
      while (alpha < color.a && Math.min(contrast(foreground, composite(color, alpha, 0)), contrast(foreground, composite(color, alpha, 255))) < 4.5) {
        alpha = Math.min(color.a, alpha + 0.025);
      }
    }
    return { ...color, a: clamp(alpha), kind: base ? "base" : info.elevated ? "overlay" : "surface" };
  }
  function css(color) {
    return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Math.round(clamp(color.a) * 1000) / 1000})`;
  }
  // Computed gradients resolve their stop colors. Images, masks, URL functions
  // and paint worklets are deliberately not rewritten.
  function gradient(image, parseColor) {
    if (!image || image === "none" || /url\(|image-set\(|paint\(/i.test(image) || !/gradient\(/i.test(image)) return null;
    const pattern = /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
    const stops = [...image.matchAll(pattern)].map(match => ({ text: match[0], color: parseColor(match[0]) }));
    if (!stops.length || stops.some(stop => !stop.color)) return null;
    const mean = { r: 0, g: 0, b: 0, a: 0 };
    for (const { color } of stops) for (const key of Object.keys(mean)) mean[key] += color[key] / stops.length;
    return { color: mean, recolor(alpha) {
      let i = 0;
      return image.replace(pattern, () => { const c = stops[i++].color; return css({ ...c, a: c.a * alpha }); });
    }, colors: stops.map(stop => stop.color) };
  }
  const api = { luminance, contrast, saturation, distance, inferTheme, surface, css, gradient };
  globalThis.HeliumGlassPalette = api;
  if (typeof module !== "undefined") module.exports = api;
})();
