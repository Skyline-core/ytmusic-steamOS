/**
 * Bridge JavaScript — modo Deck morado, táctil, MPRIS
 * Regla: NUNCA ocultar contenido de browse salvo reproductor expandido visible.
 */
window.YTMDeck = (function () {
  const POLL_MS = 2000;
  const DESIGN_W = 1280;
  const DESIGN_H = 800;
  let deckUiReady = false;
  let lastPlaying = false;
  let clutterHidden = false;
  let layoutTimer = null;
  let observerTimer = null;
  let pollTimer = null;
  let layoutInterval = null;
  let domObserver = null;
  let sideTabUserPicked = false;
  let activeQueueMenuProxy = null;

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsa(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function click(sel) {
    const el = typeof sel === "string" ? qs(sel) : sel;
    if (el) {
      el.click();
      return true;
    }
    return false;
  }

  function getVideo() {
    return qs("video");
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 40;
  }

  /** Reproductor expandido: botón "Cerrar la página del reproductor" visible */
  function isPlayerPageOpen() {
    const btn = qs(
      "ytmusic-player-bar .toggle-player-page-button yt-icon-button, ytmusic-player-bar .toggle-player-page-button button"
    );
    if (!btn) return false;
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    return /cerrar|close|collapse|contraer/.test(aria);
  }

  function isPlayingView() {
    if (isPlayerPageOpen()) return true;

    const sidePanel = qs("#side-panel");
    if (sidePanel && isVisible(sidePanel)) return true;

    return false;
  }

  function readText(sel) {
    const el = qs(sel);
    return el ? (el.textContent || "").trim() : "";
  }

  function readBarTitle() {
    return (
      readText("ytmusic-player-bar .song-info .title") ||
      readText("ytmusic-player-bar .middle-controls .title") ||
      readText("ytmusic-player-bar .title")
    );
  }

  function readBarArtist() {
    return (
      readText("ytmusic-player-bar .song-info .byline") ||
      readText("ytmusic-player-bar .middle-controls .byline") ||
      readText("ytmusic-player-bar .byline")
    );
  }

  function isAdPlaying() {
    if (qs("ytmusic-player-bar ytmusic-ad-slot-renderer, ytmusic-player-bar .ad-showing")) return true;
    const title = readBarTitle().toLowerCase();
    return /patrocinado|sponsored|anuncio|advertisement/.test(title);
  }

  function readSongTitle() {
    if (isAdPlaying()) {
      const queueTitle = readText(
        "ytmusic-queue-item[selected] .song-title, ytmusic-playlist-panel-video-renderer[selected] .song-title"
      );
      if (queueTitle) return queueTitle;
    }
    return readBarTitle();
  }

  function readSongArtist() {
    if (isAdPlaying()) {
      const queueArtist = readText(
        "ytmusic-queue-item[selected] .byline, ytmusic-playlist-panel-video-renderer[selected] .byline"
      );
      if (queueArtist) return queueArtist;
    }
    return readBarArtist();
  }

  function upscaleArtUrl(url) {
    if (!url || url.startsWith("data:")) return url;

    let next = url;
    if (/googleusercontent\.com|ggpht\.com/.test(url)) {
      next = url
        .replace(/=w\d+-h\d+(-[a-z0-9-]+)?/gi, "=w600-h600$1")
        .replace(/=s\d+(-[a-z0-9-]+)?/gi, "=s600$1")
        .replace(/\/w\d+-h\d+(-[a-z0-9-]+)?\//gi, "/w600-h600$1/");
    } else if (/ytimg\.com/.test(url)) {
      next = url
        .replace(/\/mqdefault\.jpg/i, "/maxresdefault.jpg")
        .replace(/\/hqdefault\.jpg/i, "/maxresdefault.jpg")
        .replace(/\/sddefault\.jpg/i, "/maxresdefault.jpg")
        .replace(/\/default\.jpg/i, "/maxresdefault.jpg");
    } else {
      next = url.replace(/=w\d+-h\d+/gi, "=w600-h600").replace(/=s\d+/gi, "=s600");
    }
    return next === url ? url : next;
  }

  function readArtUrl() {
    const candidates = [
      qs("ytmusic-playlist-panel-video-renderer[selected] img"),
      qs("ytmusic-queue-item[selected] img"),
      qs("ytmusic-player-bar .thumbnail-image-wrapper img"),
      qs("ytmusic-player-bar img.image"),
      qs("ytmusic-player-bar .song-image img"),
      qs("ytmusic-player-bar img"),
    ];

    for (const img of candidates) {
      if (img?.src && !img.src.startsWith("data:")) {
        return upscaleArtUrl(img.src);
      }
    }

    const video = getVideo();
    if (video?.poster) return upscaleArtUrl(video.poster);
    return "";
  }

  const DECK_ACCENT_CSS_VARS = [
    "--deck-accent",
    "--deck-accent-strong",
    "--deck-accent-dim",
    "--deck-accent-glow",
    "--deck-accent-rgb",
    "--deck-glass",
    "--deck-glass-light",
    "--deck-bg-glow",
    "--deck-bg-mid",
    "--deck-bg",
    "--deck-bar-start-rgb",
    "--deck-bar-end-rgb",
    "--deck-chip-end-rgb",
    "--deck-hero-mid",
    "--deck-hero-dark",
    "--deck-panel-rgb",
    "--deck-play-gradient-start",
    "--deck-play-icon",
  ];

  let lastAccentArtUrl = "";
  let accentColorLoading = false;
  let accentColorLoadUrl = "";

  const DECK_BG_RGB = { r: 8, g: 8, b: 10 };

  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, "0")).join("")}`;
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case rn:
          h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
          break;
        case gn:
          h = ((bn - rn) / d + 2) / 6;
          break;
        default:
          h = ((rn - gn) / d + 4) / 6;
          break;
      }
    }
    return [h * 360, s, l];
  }

  function hslToRgb(h, s, l) {
    const hue = (((h % 360) + 360) % 360) / 360;
    if (s === 0) {
      const gray = clampByte(l * 255);
      return { r: gray, g: gray, b: gray };
    }
    const hue2rgb = (p, q, t) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: clampByte(hue2rgb(p, q, hue + 1 / 3) * 255),
      g: clampByte(hue2rgb(p, q, hue) * 255),
      b: clampByte(hue2rgb(p, q, hue - 1 / 3) * 255),
    };
  }

  function luminance01(r, g, b) {
    const linear = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function parseCssColor(value) {
    const raw = (value || "").trim();
    if (!raw) return null;

    if (raw.startsWith("#")) {
      const hex = raw.slice(1);
      if (hex.length === 3) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
        };
      }
      if (hex.length >= 6) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
        };
      }
    }

    const rgbMatch = raw.match(/rgba?\(([^)]+)\)/i);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(",").map((part) => parseFloat(part.trim()));
      if (parts.length >= 3) {
        return { r: clampByte(parts[0]), g: clampByte(parts[1]), b: clampByte(parts[2]) };
      }
    }
    return null;
  }

  function tuneAccentRgb(r, g, b, neutral = false) {
    let [h, s, l] = rgbToHsl(r, g, b);
    if (neutral || s < 0.12) {
      l = Math.max(0.4, Math.min(0.7, l));
      return hslToRgb(225, 0.07, l);
    }
    if (s < 0.14) s = 0.52;
    else s = Math.min(0.95, s * 1.18);
    if (l > 0.7) l = 0.55;
    if (l < 0.2) l = 0.4;
    l = Math.max(0.34, Math.min(0.6, l));
    return hslToRgb(h, s, l);
  }

  function neutralAccentFromLuminance(avgLum) {
    if (avgLum >= 0.58) {
      const t = Math.min(1, (avgLum - 0.58) / 0.34);
      return {
        r: clampByte(158 + t * 82),
        g: clampByte(158 + t * 82),
        b: clampByte(168 + t * 78),
        neutral: true,
      };
    }
    if (avgLum <= 0.4) {
      const t = Math.min(1, (0.4 - avgLum) / 0.34);
      return {
        r: clampByte(98 - t * 42),
        g: clampByte(98 - t * 42),
        b: clampByte(108 - t * 36),
        neutral: true,
      };
    }
    const gray = clampByte(avgLum * 190 + 48);
    return { r: gray, g: gray, b: clampByte(gray + 10), neutral: true };
  }

  function extractPaletteFromImage(img) {
    const canvas = document.createElement("canvas");
    const size = 48;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    try {
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);
      const buckets = new Map();
      let neutralWeight = 0;
      let neutralLumSum = 0;
      let colorfulWeight = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 128) continue;

        const lum = luminance01(r, g, b);
        if (lum > 0.97 || lum < 0.03) continue;

        if (lum >= 0.08 && lum <= 0.94) {
          const weight = 1 - Math.abs(lum - 0.5) * 0.35;
          neutralLumSum += lum * weight;
          neutralWeight += weight;
        }

        const [, s] = rgbToHsl(r, g, b);
        if (s < 0.08) continue;
        if (lum > 0.9 || lum < 0.06) continue;

        const key = `${Math.round(r / 24) * 24},${Math.round(g / 24) * 24},${Math.round(b / 24) * 24}`;
        const score = (1 + s * 2) * (1 - Math.abs(lum - 0.42));
        const prev = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0 };
        prev.r += r * score;
        prev.g += g * score;
        prev.b += b * score;
        prev.weight += score;
        buckets.set(key, prev);
        colorfulWeight += score;
      }

      let best = null;
      for (const bucket of buckets.values()) {
        if (!bucket.weight) continue;
        const candidate = {
          r: clampByte(bucket.r / bucket.weight),
          g: clampByte(bucket.g / bucket.weight),
          b: clampByte(bucket.b / bucket.weight),
          weight: bucket.weight,
        };
        if (!best || candidate.weight > best.weight) best = candidate;
      }

      if (best) {
        const [, bestS] = rgbToHsl(best.r, best.g, best.b);
        const preferNeutral =
          neutralWeight > 0 &&
          (bestS < 0.12 || colorfulWeight < neutralWeight * 0.06);
        if (!preferNeutral) {
          return { r: best.r, g: best.g, b: best.b, neutral: false };
        }
      }

      if (neutralWeight > 0) {
        return neutralAccentFromLuminance(neutralLumSum / neutralWeight);
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  function extractDominantRgbFromImage(img) {
    const palette = extractPaletteFromImage(img);
    return palette ? { r: palette.r, g: palette.g, b: palette.b } : null;
  }

  function blendWithDark(r, g, b, amount) {
    const d = DECK_BG_RGB;
    return {
      r: clampByte(d.r + (r - d.r) * amount),
      g: clampByte(d.g + (g - d.g) * amount),
      b: clampByte(d.b + (b - d.b) * amount),
    };
  }

  function mixRgb(r, g, b, amount) {
    return {
      r: clampByte(r * amount),
      g: clampByte(g * amount),
      b: clampByte(b * amount),
    };
  }

  function lightenRgb(r, g, b, amount) {
    return {
      r: clampByte(r + (255 - r) * amount),
      g: clampByte(g + (255 - g) * amount),
      b: clampByte(b + (255 - b) * amount),
    };
  }

  function readYtmAmbientRgb() {
    const roots = [document.documentElement, qs("ytmusic-app"), qs("ytmusic-app-layout"), qs("body")].filter(
      Boolean
    );
    const varNames = [
      "--ytmusic-theme-color",
      "--ytmusic-theme-main",
      "--ytmusic-color",
      "--yt-spec-brand-background-solid",
      "--primary-background",
    ];

    for (const el of roots) {
      const style = getComputedStyle(el);
      for (const name of varNames) {
        const color = parseCssColor(style.getPropertyValue(name));
        if (color) {
          const lum = luminance01(color.r, color.g, color.b);
          if (lum > 0.05 && lum < 0.9) return color;
        }
      }
      const bg = parseCssColor(style.backgroundColor);
      if (bg) {
        const lum = luminance01(bg.r, bg.g, bg.b);
        if (lum > 0.08 && lum < 0.85) return bg;
      }
    }
    return null;
  }

  function findArtImgElement() {
    const selectors = [
      "ytmusic-player-bar .thumbnail-image-wrapper img",
      "ytmusic-player-bar img.image",
      "ytmusic-player-bar .song-image img",
      "ytmusic-queue-item[selected] img",
      "ytmusic-playlist-panel-video-renderer[selected] img",
    ];
    for (const sel of selectors) {
      const img = qs(sel);
      if (img?.src && !img.src.startsWith("data:") && img.naturalWidth > 0) return img;
    }
    return null;
  }

  function applyDeckAccentFromRgb(r, g, b, options = {}) {
    const neutral = Boolean(options.neutral);
    const base = tuneAccentRgb(r, g, b, neutral);
    const [h, s, l] = rgbToHsl(base.r, base.g, base.b);
    const strong = hslToRgb(h, Math.min(0.95, s + 0.06), Math.max(0.28, l - 0.06));
    const accent = hslToRgb(h, Math.max(0.38, s * 0.95), Math.min(0.74, l + 0.12));
    const barStart = blendWithDark(base.r, base.g, base.b, 0.58);
    const barEnd = blendWithDark(base.r, base.g, base.b, 0.38);
    const glass = blendWithDark(base.r, base.g, base.b, 0.32);
    const glassLight = blendWithDark(base.r, base.g, base.b, 0.42);
    const bgGlow = blendWithDark(base.r, base.g, base.b, 0.38);
    const bgMid = blendWithDark(base.r, base.g, base.b, 0.18);
    const heroMid = blendWithDark(base.r, base.g, base.b, 0.62);
    const chipEnd = blendWithDark(base.r, base.g, base.b, 0.52);
    const playStart = lightenRgb(accent.r, accent.g, accent.b, 0.5);
    const heroDark = blendWithDark(base.r, base.g, base.b, 0.14);
    const panel = blendWithDark(base.r, base.g, base.b, 0.28);
    const playIcon = blendWithDark(strong.r, strong.g, strong.b, 0.4);
    const root = document.documentElement;

    root.style.setProperty("--deck-accent", rgbToHex(accent.r, accent.g, accent.b));
    root.style.setProperty("--deck-accent-strong", rgbToHex(strong.r, strong.g, strong.b));
    root.style.setProperty("--deck-accent-dim", `rgba(${accent.r},${accent.g},${accent.b},0.35)`);
    root.style.setProperty("--deck-accent-glow", `rgba(${base.r},${base.g},${base.b},0.5)`);
    root.style.setProperty("--deck-accent-rgb", `${base.r},${base.g},${base.b}`);
    root.style.setProperty("--deck-glass", `rgba(${glass.r},${glass.g},${glass.b},0.88)`);
    root.style.setProperty("--deck-glass-light", `rgba(${glassLight.r},${glassLight.g},${glassLight.b},0.55)`);
    root.style.setProperty("--deck-bg-glow", rgbToHex(bgGlow.r, bgGlow.g, bgGlow.b));
    root.style.setProperty("--deck-bg-mid", rgbToHex(bgMid.r, bgMid.g, bgMid.b));
    root.style.setProperty("--deck-bg", "#08080a");
    root.style.setProperty("--deck-bar-start-rgb", `${barStart.r},${barStart.g},${barStart.b}`);
    root.style.setProperty("--deck-bar-end-rgb", `${barEnd.r},${barEnd.g},${barEnd.b}`);
    root.style.setProperty("--deck-chip-end-rgb", `${chipEnd.r},${chipEnd.g},${chipEnd.b}`);
    root.style.setProperty("--deck-hero-mid", rgbToHex(heroMid.r, heroMid.g, heroMid.b));
    root.style.setProperty("--deck-hero-dark", rgbToHex(heroDark.r, heroDark.g, heroDark.b));
    root.style.setProperty("--deck-panel-rgb", `${panel.r},${panel.g},${panel.b}`);
    root.style.setProperty("--deck-play-gradient-start", rgbToHex(playStart.r, playStart.g, playStart.b));
    root.style.setProperty("--deck-play-icon", rgbToHex(playIcon.r, playIcon.g, playIcon.b));
    root.classList.add("ytm-deck-accent-dynamic");
    paintDeckAccentSurfaces();
    paintDeckAccentTabs();
  }

  function paintDeckAccentTabs() {
    const inactive = "rgba(255, 255, 255, 0.56)";
    const active =
      getComputedStyle(document.documentElement).getPropertyValue("--deck-accent").trim() || "#8a8a9a";

    qsa("#side-panel tp-yt-paper-tabs, ytmusic-browse-response ytmusic-tabs").forEach((tabs) => {
      tabs.style.setProperty("--paper-tab-content-unselected", inactive, "important");
      tabs.style.setProperty("--paper-tab-content", inactive, "important");
      tabs.style.setProperty("--paper-tab-content-selected", active, "important");
      tabs.style.setProperty("--paper-tab-ink", active, "important");
    });

    qsa("#side-panel tp-yt-paper-tab, #side-panel paper-tab").forEach((tab) => {
      const selected = tab.classList.contains("iron-selected");
      const color = selected ? active : inactive;
      tab.style.setProperty("color", color, "important");
      tab.style.setProperty("-webkit-text-fill-color", color, "important");
      qsa(".tab-content, yt-formatted-string", tab).forEach((el) => {
        el.style.setProperty("color", color, "important");
        el.style.setProperty("-webkit-text-fill-color", color, "important");
      });
    });

    qsa("ytmusic-browse-response ytmusic-tabs .tab, ytmusic-browse-response ytmusic-tabs yt-formatted-string.tab").forEach(
      (tab) => {
        const selected = tab.classList.contains("selected") || tab.getAttribute("aria-selected") === "true";
        const color = selected ? active : inactive;
        tab.style.setProperty("color", color, "important");
        tab.style.setProperty("-webkit-text-fill-color", color, "important");
      }
    );
  }

  function paintDeckAccentSurfaces() {
    const panelRgb = getComputedStyle(document.documentElement).getPropertyValue("--deck-panel-rgb").trim();
    if (panelRgb) {
      const panelBg = `rgba(${panelRgb}, 0.75)`;
      qsa("#side-panel, .deck-side-panel").forEach((el) => {
        el.style.setProperty("background", panelBg, "important");
      });
    }

    qsa(
      "ytmusic-player-page, #player-page, ytmusic-app-layout, #content, ytmusic-browse-response, ytmusic-browse-response ytmusic-tabs, .background-gradient, .browse-background, .gradient-container"
    ).forEach((el) => {
      el.style.setProperty("background", "transparent", "important");
      el.style.setProperty("background-color", "transparent", "important");
      el.style.setProperty("background-image", "none", "important");
    });

    const barStart = getComputedStyle(document.documentElement).getPropertyValue("--deck-bar-start-rgb").trim();
    const barEnd = getComputedStyle(document.documentElement).getPropertyValue("--deck-bar-end-rgb").trim();
    if (barStart && barEnd) {
      const barBg = `linear-gradient(135deg, rgba(${barStart}, 0.97), rgba(${barEnd}, 0.95))`;
      qsa("ytmusic-player-bar").forEach((bar) => {
        bar.style.setProperty("background", barBg, "important");
      });
    }
  }

  function resetDeckAccentTheme() {
    const root = document.documentElement;
    DECK_ACCENT_CSS_VARS.forEach((name) => root.style.removeProperty(name));
    root.classList.remove("ytm-deck-accent-dynamic");
    qsa("#side-panel, .deck-side-panel").forEach((el) => el.style.removeProperty("background"));
    qsa("#side-panel tp-yt-paper-tab, #side-panel paper-tab").forEach((tab) => {
      tab.style.removeProperty("color");
      tab.style.removeProperty("-webkit-text-fill-color");
      qsa(".tab-content, yt-formatted-string", tab).forEach((el) => {
        el.style.removeProperty("color");
        el.style.removeProperty("-webkit-text-fill-color");
      });
    });
    qsa("#side-panel tp-yt-paper-tabs").forEach((tabs) => {
      tabs.style.removeProperty("--paper-tab-content-unselected");
      tabs.style.removeProperty("--paper-tab-content");
      tabs.style.removeProperty("--paper-tab-content-selected");
      tabs.style.removeProperty("--paper-tab-ink");
    });
    qsa(
      "ytmusic-player-page, #player-page, ytmusic-app-layout, #content, .background-gradient, .browse-background, ytmusic-player-bar"
    ).forEach((el) => {
      el.style.removeProperty("background");
      el.style.removeProperty("background-color");
      el.style.removeProperty("background-image");
    });
  }

  function artUrlProbeCandidates(url) {
    return [
      ...new Set([
        url,
        url.replace(/maxresdefault\.jpg/i, "hqdefault.jpg"),
        url.replace(/sddefault\.jpg/i, "hqdefault.jpg"),
        url.replace(/\/w600-h600/i, "/w300-h300"),
        url.replace(/=w600-h600/i, "=w300-h300"),
      ]),
    ];
  }

  function tryApplyAccentFromImage(img) {
    if (!img?.complete || !img.naturalWidth) return false;
    const palette = extractPaletteFromImage(img);
    if (!palette) return false;
    applyDeckAccentFromRgb(palette.r, palette.g, palette.b, { neutral: palette.neutral });
    return true;
  }

  function collectAccentImageCandidates(artUrl) {
    const items = [];
    const seen = new Set();
    const add = (img) => {
      if (!img?.src || img.src.startsWith("data:") || seen.has(img)) return;
      seen.add(img);
      items.push(img);
    };

    add(qs(".deck-now-playing-art"));
    add(findArtImgElement());
    add(qs("ytmusic-playlist-panel-video-renderer[selected] img"));
    add(qs("ytmusic-queue-item[selected] img"));
    qsa(
      "ytmusic-player-bar .thumbnail-image-wrapper img, ytmusic-player-bar img.image, ytmusic-player-bar .song-image img"
    ).forEach(add);

    return items.filter((img) => {
      if (!artUrl) return true;
      if (img.classList?.contains("deck-now-playing-art")) {
        const heroUrl = img.dataset.deckArtUrl || img.src;
        return upscaleArtUrl(heroUrl) === upscaleArtUrl(artUrl);
      }
      return true;
    });
  }

  function loadArtAccentColor(url) {
    if (!url) return;
    if (accentColorLoading && accentColorLoadUrl === url) return;

    const urls = artUrlProbeCandidates(url);
    accentColorLoading = true;
    accentColorLoadUrl = url;

    const attempt = (index) => {
      if (index >= urls.length) {
        accentColorLoading = false;
        accentColorLoadUrl = "";
        for (const img of collectAccentImageCandidates(url)) {
          if (tryApplyAccentFromImage(img)) {
            lastAccentArtUrl = url;
            return;
          }
        }
        applyDeckAccentFromRgb(168, 168, 176, { neutral: true });
        lastAccentArtUrl = url;
        return;
      }

      const probe = new Image();
      probe.crossOrigin = "anonymous";
      probe.onload = () => {
        if (tryApplyAccentFromImage(probe)) {
          accentColorLoading = false;
          accentColorLoadUrl = "";
          lastAccentArtUrl = url;
          return;
        }
        attempt(index + 1);
      };
      probe.onerror = () => attempt(index + 1);
      probe.src = urls[index];
    };

    attempt(0);
  }

  function syncDeckAccentTheme() {
    if (!isMediaActive()) {
      if (lastAccentArtUrl) resetDeckAccentTheme();
      lastAccentArtUrl = "";
      return;
    }

    const artUrl = readArtUrl();
    if (!artUrl) return;

    if (
      artUrl === lastAccentArtUrl &&
      document.documentElement.classList.contains("ytm-deck-accent-dynamic")
    ) {
      paintDeckAccentSurfaces();
      paintDeckAccentTabs();
      return;
    }

    for (const img of collectAccentImageCandidates(artUrl)) {
      if (tryApplyAccentFromImage(img)) {
        lastAccentArtUrl = artUrl;
        return;
      }
    }

    loadArtAccentColor(artUrl);
  }

  function setHeroArt(art, url) {
    if (!art || !url) return;
    const hi = upscaleArtUrl(url);
    if (art.dataset.deckArtUrl === hi) {
      syncDeckAccentTheme();
      return;
    }
    art.dataset.deckArtUrl = hi;
    art.dataset.deckArtFallback = url;
    art.addEventListener(
      "error",
      function onArtError() {
        if (art.dataset.deckArtFallback && art.src !== art.dataset.deckArtFallback) {
          art.src = art.dataset.deckArtFallback;
        }
      },
      { once: true }
    );
    art.src = hi;
    art.addEventListener(
      "load",
      () => {
        syncDeckAccentTheme();
      },
      { once: true }
    );
  }

  function readLoopStatus() {
    const repeat = qs(
      'ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]'
    );
    if (!repeat) return "None";
    const label = (repeat.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("one") || label.includes("una")) return "Track";
    if (label.includes("all") || label.includes("todas") || label.includes("activado"))
      return "Playlist";
    return "None";
  }

  function readShuffle() {
    const shuffle = qs(
      'ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]'
    );
    if (!shuffle) return false;
    const pressed = shuffle.getAttribute("aria-pressed");
    if (pressed != null) return pressed === "true";
    const label = (shuffle.getAttribute("aria-label") || "").toLowerCase();
    return label.includes("on") || label.includes("activado");
  }

  function isValidArtImg(img) {
    if (!img) return false;
    const src = (img.currentSrc || img.src || "").trim();
    if (!src || src.startsWith("data:")) return false;
    if (img.complete && img.naturalWidth === 0) return false;
    return true;
  }

  function hasValidBarArt() {
    return qsa(
      "ytmusic-player-bar .thumbnail-image-wrapper img, ytmusic-player-bar .song-image img, ytmusic-player-bar img.image, ytmusic-player-bar ytmusic-thumbnail-renderer img, ytmusic-player-bar yt-img-shadow img"
    ).some(isValidArtImg);
  }

  function isMediaActive() {
    const video = getVideo();
    if (video && Number.isFinite(video.duration) && video.duration > 0) return true;
    return hasValidBarArt();
  }

  function setPlayerBarThumbVisible(el, visible) {
    if (!el) return;
    if (visible) {
      el.style.removeProperty("display");
      el.style.removeProperty("visibility");
      el.style.removeProperty("width");
      el.style.removeProperty("height");
      el.style.removeProperty("min-width");
      el.style.removeProperty("min-height");
      el.style.removeProperty("max-width");
      el.style.removeProperty("max-height");
      el.style.removeProperty("margin");
      el.style.removeProperty("padding");
      el.style.removeProperty("flex");
      el.style.removeProperty("overflow");
      el.style.removeProperty("pointer-events");
      return;
    }
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("width", "0", "important");
    el.style.setProperty("height", "0", "important");
    el.style.setProperty("min-width", "0", "important");
    el.style.setProperty("min-height", "0", "important");
    el.style.setProperty("max-width", "0", "important");
    el.style.setProperty("max-height", "0", "important");
    el.style.setProperty("margin", "0", "important");
    el.style.setProperty("padding", "0", "important");
    el.style.setProperty("overflow", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("flex", "0 0 0", "important");
  }

  function syncPlayerBarThumbnail() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return;

    const active = isMediaActive();
    const thumbSelectors =
      ".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer, yt-img-shadow.image, yt-img-shadow#thumbnail";

    qsa(thumbSelectors, bar).forEach((el) => {
      const img = qs("img", el);
      const show = active && isValidArtImg(img);
      setPlayerBarThumbVisible(el, show);
    });

    qsa("img.image, img#img", bar).forEach((img) => {
      if (!img.closest(".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer, yt-img-shadow")) {
        setPlayerBarThumbVisible(img, active && isValidArtImg(img));
      }
    });
  }

  function syncMediaActiveUi() {
    const active = isMediaActive();
    document.documentElement.classList.toggle("ytm-deck-media-active", active);
    syncPlayerBarThumbnail();
    return active;
  }

  function collectState() {
    const video = getVideo();
    const duration = video ? video.duration || 0 : 0;
    const current = video ? video.currentTime || 0 : 0;
    const paused = video ? video.paused : true;
    const title = readSongTitle() || readText(".deck-now-playing-meta .deck-title");
    const artist = readSongArtist() || readText(".deck-now-playing-meta .deck-artist");

    let playbackStatus = "Stopped";
    if (video && duration > 0) playbackStatus = paused ? "Paused" : "Playing";
    else if (title) playbackStatus = paused ? "Paused" : "Playing";

    return {
      title,
      artist,
      album: "",
      artUrl: readArtUrl(),
      trackId: (title + artist).replace(/\s+/g, "_").slice(0, 80),
      lengthUs: Math.round(duration * 1_000_000),
      positionUs: Math.round(current * 1_000_000),
      playbackStatus,
      volume: video ? video.volume : 1,
      canPlay: !!video,
      canPause: !!video,
      canGoNext: !!qs('ytmusic-player-bar .next-button, ytmusic-player-bar [aria-label*="Next"], ytmusic-player-bar [aria-label*="Siguiente"]'),
      canGoPrevious: !!qs('ytmusic-player-bar .previous-button, ytmusic-player-bar [aria-label*="Previous"], ytmusic-player-bar [aria-label*="Anterior"]'),
      canSeek: !!video && duration > 0,
      shuffle: readShuffle(),
      loopStatus: readLoopStatus(),
    };
  }

  function reportState() {
    if (!window.bridge || !window.bridge.reportState) return;
    try {
      window.bridge.reportState(JSON.stringify(collectState()));
    } catch (_) {}
  }

  function ensureDeckClass() {
    const root = document.documentElement;
    root.classList.add("ytm-deck-mode");
    root.setAttribute("data-ytm-deck", "1");
  }

  function deckPx(value, scale) {
    return `${Math.round(value * scale)}px`;
  }

  function resolveViewportSize() {
    const iw = window.innerWidth || 0;
    const ih = window.innerHeight || 0;
    const sw = window.screen?.width || 0;
    const sh = window.screen?.height || 0;
    const dpr = window.devicePixelRatio || 1;

    let w = Math.max(iw, sw, DESIGN_W);
    let h = Math.max(ih, sh, DESIGN_H);

    // Big Picture / Gamescope: viewport lógico pequeño en pantalla grande
    if (iw > 0 && iw < DESIGN_W * 0.95 && (sw >= DESIGN_W || dpr > 1.15)) {
      w = Math.max(w, Math.round(iw * Math.max(dpr, 1.25)));
      h = Math.max(h, Math.round(ih * Math.max(dpr, 1.25)));
    }

    return { w, h, dpr };
  }

  function computeDeckScale(w, h) {
    let scale = Math.min(w / DESIGN_W, h / DESIGN_H);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;

    const screenScale = Math.min(
      (window.screen?.width || w) / DESIGN_W,
      (window.screen?.height || h) / DESIGN_H
    );
    if (Number.isFinite(screenScale) && screenScale > scale) {
      scale = screenScale;
    }

    const forced = parseFloat(window.__YTM_DECK_UI_SCALE__);
    if (Number.isFinite(forced) && forced > 0) {
      scale = Math.max(scale, forced);
    }

    if (scale < 1.0) scale = 1.0;
    return Math.min(1.75, scale);
  }

  function applyViewportMetrics() {
    const { w, h } = resolveViewportSize();
    const aspect = w / Math.max(h, 1);
    const scale = computeDeckScale(w, h);
    const wide = aspect >= 1.55;
    const root = document.documentElement;

    root.style.setProperty("--deck-ui-scale", scale.toFixed(3));
    root.style.setProperty("--deck-nav-w", deckPx(300, scale));
    root.style.setProperty("--deck-player-h", deckPx(wide ? 108 : 112, scale));
    root.style.setProperty("--deck-touch-xl", deckPx(72, scale));
    root.style.setProperty("--deck-touch", deckPx(56, scale));
    root.style.setProperty("--deck-player-thumb", deckPx(58, scale));
    root.style.setProperty("--deck-gap", deckPx(10, scale));
    root.style.setProperty("--deck-col-gap", deckPx(6, scale));
    root.style.setProperty("--deck-content-pad", deckPx(12, scale));
    root.style.setProperty("--deck-volume-slider-w", deckPx(wide ? 120 : 150, scale));
    root.style.setProperty("--deck-fs-nav", deckPx(18, scale));
    root.style.setProperty("--deck-fs-chip", deckPx(16, scale));
    root.style.setProperty("--deck-fs-body", deckPx(15, scale));
    root.style.setProperty("--deck-fs-item-title", deckPx(17, scale));
    root.style.setProperty("--deck-fs-section", deckPx(24, scale));
    root.style.setProperty("--deck-fs-player-title", deckPx(17, scale));
    root.style.setProperty("--deck-fs-player-artist", deckPx(15, scale));
    root.style.setProperty("--deck-player-progress-inset-left", deckPx(42, scale));
    root.style.setProperty("--deck-player-progress-inset-right", deckPx(42, scale));
    root.classList.toggle("ytm-deck-wide", wide);
    root.classList.toggle("ytm-deck-large-ui", scale >= 1.28);

    const drawer = qs("tp-yt-app-drawer#guide");
    if (drawer) {
      drawer.style.setProperty("--paper-drawer-width", deckPx(300, scale));
    }
  }

  function setPlayingMode(playing) {
    const changed = playing !== lastPlaying;
    if (changed) {
      lastPlaying = playing;
      document.documentElement.classList.toggle("ytm-deck-playing", playing);
    }
  }

  function removeHeroUi() {
    const hero = qs(".deck-hero-wrap");
    if (hero) hero.remove();
  }

  function trimHeroUi() {
    qs(".deck-progress-wrap")?.remove();
  }

  function buildHeroUi() {
    const playerPage = qs("ytmusic-player-page");
    if (!playerPage) return;

    let wrap = qs(".deck-hero-wrap", playerPage);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "deck-hero-wrap";

      const art = document.createElement("img");
      art.className = "deck-now-playing-art";
      art.alt = "Portada";
      art.crossOrigin = "anonymous";

      const meta = document.createElement("div");
      meta.className = "deck-now-playing-meta";
      const titleEl = document.createElement("div");
      titleEl.className = "deck-title";
      const artistEl = document.createElement("div");
      artistEl.className = "deck-artist";
      meta.appendChild(titleEl);
      meta.appendChild(artistEl);

      wrap.appendChild(art);
      wrap.appendChild(meta);
      playerPage.prepend(wrap);
    }

    trimHeroUi();

    const titleEl = qs(".deck-title", wrap);
    const artistEl = qs(".deck-artist", wrap);
    const art = qs(".deck-now-playing-art", wrap);
    const barTitle = readSongTitle();
    const barArtist = readSongArtist();
    if (titleEl && barTitle) titleEl.textContent = barTitle;
    if (artistEl && barArtist) artistEl.textContent = barArtist;
    const artUrl = readArtUrl();
    if (art && artUrl) setHeroArt(art, artUrl);
  }

  function mountSidePanel() {
    const sidePanel = qs("#side-panel");
    if (!sidePanel) return;

    sidePanel.classList.add("deck-side-panel");
    bindSidePanelTabs();
    if (!qs(".deck-queue-subtitle", sidePanel)) {
      const sub = document.createElement("div");
      sub.className = "deck-queue-subtitle";
      sidePanel.insertBefore(sub, sidePanel.firstChild);
    }
    syncDeckAccentTheme();
    paintDeckAccentSurfaces();
    paintDeckAccentTabs();
  }

  function ensureAccountMenuAccess() {
    const buttonBar = qs("ytmusic-nav-bar #button-bar");
    if (!buttonBar) return;
    buttonBar.style.display = "flex";
    buttonBar.style.visibility = "visible";
    buttonBar.style.pointerEvents = "auto";
    buttonBar.style.zIndex = "80";
  }

  function forEachShadowRoot(node, visit) {
    if (!node) return;
    const stack = [node];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      visit(cur);
      if (cur.shadowRoot) stack.push(cur.shadowRoot);
      qsa("*", cur).forEach((child) => {
        if (child.shadowRoot) stack.push(child.shadowRoot);
      });
    }
  }

  const QUEUE_ITEM_SHADOW_CSS = `
    :host {
      --ytmusic-menu-renderer-button-opacity: 1 !important;
      --yt-endpoint-action-button-opacity: 1 !important;
      position: relative !important;
      touch-action: pan-y !important;
    }
    :host(:not(:hover)) #menu,
    #menu,
    .menu,
    ytmusic-menu-renderer,
    ytmusic-item-menu-renderer {
      position: absolute !important;
      opacity: 0 !important;
      visibility: visible !important;
      display: flex !important;
      width: 40px !important;
      min-width: 40px !important;
      max-width: 40px !important;
      height: 40px !important;
      overflow: visible !important;
      pointer-events: none !important;
      transition: none !important;
      transform: none !important;
      z-index: 2 !important;
    }
    #flex-columns,
    .flex-columns {
      display: flex !important;
      align-items: center !important;
      justify-content: flex-end !important;
      gap: 0 !important;
      flex: 0 0 auto !important;
      margin-left: auto !important;
      min-width: 0 !important;
      overflow: visible !important;
    }
    .deck-queue-actions {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: flex-end !important;
      gap: 8px !important;
      flex: 0 0 auto !important;
      margin-left: auto !important;
      min-width: 92px !important;
      padding-left: 6px !important;
      position: relative !important;
      pointer-events: none !important;
    }
    .deck-queue-duration,
    .duration,
    yt-formatted-string.duration {
      order: 1 !important;
      flex: 0 0 auto !important;
      min-width: 38px !important;
      margin: 0 !important;
      padding: 0 2px 0 0 !important;
      text-align: right !important;
      font-variant-numeric: tabular-nums !important;
      pointer-events: none !important;
    }
    .deck-queue-menu-proxy {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex: 0 0 40px !important;
      width: 40px !important;
      min-width: 40px !important;
      height: 40px !important;
      min-height: 40px !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 50% !important;
      background: transparent !important;
      color: rgba(220, 200, 255, 0.62) !important;
      font-size: 22px !important;
      line-height: 1 !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
      cursor: pointer !important;
      order: 2 !important;
      touch-action: manipulation !important;
      position: relative !important;
      z-index: 3 !important;
    }
  `;

  function injectQueueItemHostStyle(host) {
    if (!host?.shadowRoot) return;
    if (host.shadowRoot.querySelector("[data-deck-queue-item-style]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-deck-queue-item-style", "1");
    style.textContent = QUEUE_ITEM_SHADOW_CSS;
    host.shadowRoot.appendChild(style);
  }

  function injectQueueMenuShadowStyle(host) {
    if (!host?.shadowRoot) return;
    if (host.shadowRoot.querySelector("[data-deck-queue-menu-style]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-deck-queue-menu-style", "1");
    style.textContent = `
      :host {
        opacity: 1 !important;
        visibility: visible !important;
        --ytmusic-menu-renderer-button-opacity: 1 !important;
      }
      #button,
      yt-icon-button,
      tp-yt-paper-icon-button,
      button {
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
        display: flex !important;
      }
    `;
    host.shadowRoot.appendChild(style);
  }

  function findQueueMenuContainer(item) {
    let found = null;
    forEachShadowRoot(item, (root) => {
      if (found) return;
      found = qs("#menu, ytmusic-menu-renderer, ytmusic-item-menu-renderer", root);
    });
    return found;
  }

  function ensureQueueActionsRow(item) {
    const roots = [];
    if (item.shadowRoot) roots.push(item.shadowRoot);
    roots.push(item);

    roots.forEach((root) => {
      const flex = qs("#flex-columns, .flex-columns", root);
      let row = qs(".deck-queue-actions", root);
      if (!row) {
        row = document.createElement("div");
        row.className = "deck-queue-actions";
        if (flex) flex.appendChild(row);
        else root.appendChild(row);
      } else if (flex && row.parentElement !== flex) {
        flex.appendChild(row);
      }

      qsa(".duration, yt-formatted-string.duration", root).forEach((dur) => {
        dur.classList.add("deck-queue-duration");
        if (!row.contains(dur)) row.appendChild(dur);
      });

      const proxy = qs(".deck-queue-menu-proxy", root);
      if (proxy && !row.contains(proxy)) row.appendChild(proxy);
    });
  }

  function alignNativeMenuToProxy(item, proxy) {
    const menu = findQueueMenuContainer(item);
    const realBtn = findQueueMenuButton(item);
    if (!menu || !proxy) return;

    const hostRect = item.getBoundingClientRect();
    const proxyRect = proxy.getBoundingClientRect();

    menu.style.setProperty("position", "absolute", "important");
    menu.style.setProperty("display", "flex", "important");
    menu.style.setProperty("opacity", "0", "important");
    menu.style.setProperty("visibility", "visible", "important");
    menu.style.setProperty("width", "40px", "important");
    menu.style.setProperty("height", "40px", "important");
    menu.style.setProperty("min-width", "40px", "important");
    menu.style.setProperty("max-width", "40px", "important");
    menu.style.setProperty("top", `${proxyRect.top - hostRect.top}px`, "important");
    menu.style.setProperty("left", `${proxyRect.left - hostRect.left}px`, "important");
    menu.style.setProperty("right", "auto", "important");
    menu.style.setProperty("bottom", "auto", "important");
    menu.style.setProperty("pointer-events", "none", "important");
    menu.style.setProperty("z-index", "2", "important");
    menu.style.setProperty("overflow", "visible", "important");

    if (realBtn) {
      realBtn.style.setProperty("width", "40px", "important");
      realBtn.style.setProperty("height", "40px", "important");
      realBtn.style.setProperty("min-width", "40px", "important");
      realBtn.style.setProperty("min-height", "40px", "important");
    }
  }

  function isQueuePopupOpen(dropdown) {
    if (!dropdown) return false;
    if (dropdown.hasAttribute("opened") || dropdown.opened) return true;
    if (dropdown.classList.contains("iron-dropdown-opened")) return true;
    const hidden = dropdown.hasAttribute("aria-hidden")
      ? dropdown.getAttribute("aria-hidden") === "true"
      : false;
    if (hidden) return false;
    const rect = dropdown.getBoundingClientRect();
    return rect.width > 40 && rect.height > 40;
  }

  function repositionQueuePopups(anchor) {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 280;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = Math.min(rect.bottom + 6, window.innerHeight - 16);

    qsa(
      "tp-yt-iron-dropdown.ytmusic-popup-container, ytmusic-popup-container tp-yt-iron-dropdown, tp-yt-iron-dropdown"
    ).forEach((dropdown) => {
      if (!isQueuePopupOpen(dropdown)) return;
      dropdown.style.setProperty("position", "fixed", "important");
      dropdown.style.setProperty("left", `${left}px`, "important");
      dropdown.style.setProperty("top", `${top}px`, "important");
      dropdown.style.setProperty("right", "auto", "important");
      dropdown.style.setProperty("bottom", "auto", "important");
      dropdown.style.setProperty("transform", "none", "important");
      dropdown.style.setProperty("margin", "0", "important");
    });
  }

  function openQueueMenuFromProxy(item, proxy, realBtn) {
    activeQueueMenuProxy = proxy;
    alignNativeMenuToProxy(item, proxy);
    realBtn.click();
    const fix = () => repositionQueuePopups(proxy);
    requestAnimationFrame(fix);
    setTimeout(fix, 0);
    setTimeout(fix, 40);
    setTimeout(fix, 120);
    setTimeout(fix, 240);
  }

  function findQueueMenuButton(item) {
    const menuLabel = /menu|menú|acción|action|more|más|opciones|options/i;
    let found = null;

    forEachShadowRoot(item, (root) => {
      if (found) return;
      qsa("#menu, ytmusic-menu-renderer, ytmusic-item-menu-renderer", root).forEach((menu) => {
        if (found) return;
        const btn = qs("yt-icon-button, tp-yt-paper-icon-button, #button, button", menu);
        if (btn) found = btn;
      });
    });

    if (found) return found;

    forEachShadowRoot(item, (root) => {
      if (found) return;
      qsa("yt-icon-button, tp-yt-paper-icon-button, button", root).forEach((btn) => {
        if (found) return;
        const label = btn.getAttribute("aria-label") || "";
        if (menuLabel.test(label)) found = btn;
      });
    });

    return found;
  }

  function mountQueueMenuProxy(item) {
    const realBtn = findQueueMenuButton(item);
    if (!realBtn) return;

    ensureQueueActionsRow(item);

    const roots = [];
    if (item.shadowRoot) roots.push(item.shadowRoot);
    roots.push(item);

    for (const root of roots) {
      const row = qs(".deck-queue-actions", root);
      const anchor = row || qs("#flex-columns, .flex-columns", root) || root;
      if (!anchor) continue;

      let proxy = qs(".deck-queue-menu-proxy", anchor);
      if (!proxy) {
        proxy = document.createElement("button");
        proxy.type = "button";
        proxy.className = "deck-queue-menu-proxy";
        anchor.appendChild(proxy);
      } else if (!anchor.contains(proxy)) {
        anchor.appendChild(proxy);
      }

      const label = realBtn.getAttribute("aria-label") || "Menú de acciones";
      proxy.setAttribute("aria-label", label);
      proxy.textContent = "⋮";
      proxy.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        openQueueMenuFromProxy(item, proxy, realBtn);
      };

      alignNativeMenuToProxy(item, proxy);
      return;
    }
  }

  function layoutQueueItemMenu(item) {
    /* La duración vive en .deck-queue-actions; el menú nativo se posiciona con alignNativeMenuToProxy */
  }

  function playQueueItem(item) {
    if (!item) return false;
    let played = false;
    forEachShadowRoot(item, (root) => {
      if (played) return;
      const endpoint =
        qs("a.yt-simple-endpoint", root) ||
        qs("#navigation-endpoint", root) ||
        qs(".song-title a", root) ||
        qs(".song-title", root);
      if (endpoint) {
        endpoint.click();
        played = true;
      }
    });
    if (!played) item.click();
    return played;
  }

  function isTextField(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  function isQueueItemTarget(target) {
    return !!target?.closest?.(
      "#side-panel ytmusic-playlist-panel-video-renderer, #side-panel ytmusic-queue-item, #side-panel ytmusic-player-queue-item"
    );
  }

  function clickDeckTarget(el) {
    if (!el) return false;
    const interactive = el.closest?.(
      "a.yt-simple-endpoint, tp-yt-paper-item, #endpoint, button, yt-icon-button, tp-yt-paper-icon-button, ytmusic-guide-entry-renderer"
    );
    const target = interactive || el;
    if (typeof target.click === "function") {
      target.click();
      return true;
    }
    return false;
  }

  function closeOpenPopups() {
    let closed = false;
    qsa("tp-yt-iron-dropdown[opened], tp-yt-iron-dropdown.iron-dropdown-opened").forEach((dropdown) => {
      if (typeof dropdown.close === "function") {
        dropdown.close();
        closed = true;
      } else {
        dropdown.removeAttribute("opened");
        closed = true;
      }
    });
    return closed;
  }

  function deckActivate() {
    const active = document.activeElement;
    if (!isTextField(active) && active && active !== document.body && active !== document.documentElement) {
      if (clickDeckTarget(active)) return;
    }

    const guideActive = qs("ytmusic-guide-entry-renderer[active] #endpoint, ytmusic-guide-entry-renderer[active] a.yt-simple-endpoint");
    if (guideActive) {
      guideActive.click();
      return;
    }

    const hovered = qs(
      "ytmusic-two-row-item-renderer:hover, ytmusic-multi-carousel-item-renderer:hover, ytmusic-responsive-list-item-renderer:hover, ytmusic-guide-entry-renderer:hover"
    );
    if (hovered && clickDeckTarget(hovered)) return;

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
    );
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  }

  function deckBack() {
    if (closeOpenPopups()) return;

    if (isPlayerPageOpen()) {
      click("ytmusic-player-bar .toggle-player-page-button");
      return;
    }

    const searchOpen = qs("ytmusic-search-box[opened], ytmusic-search-box[visible]");
    if (searchOpen) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return;
    }

    if (window.history.length > 1) {
      window.history.back();
    }
  }

  function getDeckScrollTarget(horizontal) {
    if (horizontal) {
      const carousel = qs("ytmusic-carousel-shelf-renderer ytmusic-carousel #items, ytmusic-carousel #items");
      if (carousel && carousel.scrollWidth > carousel.clientWidth + 4) return carousel;
    }

    if (isPlayerPageOpen()) {
      const queue = qs("#side-panel ytmusic-tab-renderer, #side-panel ytmusic-queue-tab, #side-panel");
      if (queue && queue.scrollHeight > queue.clientHeight + 4) return queue;
    }

    const guide = qs("tp-yt-app-drawer#guide #guide-content, #guide-content");
    if (guide && guide.scrollHeight > guide.clientHeight + 4) return guide;

    const browse = qs("ytmusic-browse-response, ytmusic-search-response");
    if (browse && browse.scrollHeight > browse.clientHeight + 4) return browse;

    return qs("#content") || document.scrollingElement || document.documentElement;
  }

  function deckScrollStick(dx, dy) {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const horizontal = absX > absY;
    const target = getDeckScrollTarget(horizontal);
    if (!target) return;

    if (horizontal && absX > 0.25) {
      target.scrollLeft += dx * 34;
      return;
    }
    if (absY > 0.25) {
      target.scrollTop += dy * 34;
    }
  }

  function bindDeckInput() {
    if (window.__YTM_DECK_INPUT_BOUND__) return;
    window.__YTM_DECK_INPUT_BOUND__ = true;

    const STICK_DEADZONE = 0.28;
    const prevButtons = new Map();

    document.addEventListener(
      "keydown",
      (event) => {
        if (isTextField(event.target)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          deckBack();
          return;
        }
        if (event.key === "Enter" && !event.repeat) {
          if (isQueueItemTarget(event.target)) return;
          event.preventDefault();
          deckActivate();
        }
      },
      true
    );

    window.addEventListener("gamepadconnected", () => {
      logBridge("gamepad conectado");
    });

    const pollGamepad = () => {
      const pads = navigator.getGamepads?.() || [];
      for (const pad of pads) {
        if (!pad) continue;
        const prev = prevButtons.get(pad.index) || [];

        if (pad.buttons[0]?.pressed && !prev[0]) deckActivate();
        if (pad.buttons[1]?.pressed && !prev[1]) deckBack();

        const rx = pad.axes[2] ?? 0;
        const ry = pad.axes[3] ?? 0;
        if (Math.abs(rx) > STICK_DEADZONE || Math.abs(ry) > STICK_DEADZONE) {
          const nx = Math.abs(rx) > STICK_DEADZONE ? rx : 0;
          const ny = Math.abs(ry) > STICK_DEADZONE ? ry : 0;
          deckScrollStick(nx, ny);
        }

        prevButtons.set(
          pad.index,
          Array.from(pad.buttons, (btn) => btn.pressed)
        );
      }
      requestAnimationFrame(pollGamepad);
    };
    requestAnimationFrame(pollGamepad);
  }

  function logBridge(message) {
    if (window.bridge && typeof window.bridge.log === "function") {
      window.bridge.log(`[ytm-deck] ${message}`);
    }
  }

  function bindQueuePanelTouch() {
    const panel = qs("#side-panel");
    if (!panel || panel.dataset.deckQueueTouchBound) return;
    panel.dataset.deckQueueTouchBound = "1";

    const TAP_MS = 320;
    const LONG_MS = 420;
    const MOVE_PX = 10;
    let press = null;
    let suppressClick = false;

    const itemFrom = (target) =>
      target?.closest?.(
        "ytmusic-playlist-panel-video-renderer, ytmusic-queue-item, ytmusic-player-queue-item"
      );

    const clearPress = () => {
      press = null;
    };

    panel.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        if (event.target.closest(".deck-queue-menu-proxy")) return;
        const item = itemFrom(event.target);
        if (!item) return;
        suppressClick = false;
        press = {
          item,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          t: performance.now(),
          moved: false,
          long: false,
        };
      },
      true
    );

    panel.addEventListener(
      "pointermove",
      (event) => {
        if (!press || event.pointerId !== press.id) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_PX) {
          press.moved = true;
        }
      },
      true
    );

    panel.addEventListener(
      "pointerup",
      (event) => {
        if (!press || event.pointerId !== press.id) return;
        const snapshot = press;
        clearPress();
        if (event.target.closest(".deck-queue-menu-proxy")) return;
        const elapsed = performance.now() - snapshot.t;
        if (snapshot.moved || elapsed >= LONG_MS) {
          suppressClick = true;
          return;
        }
        if (elapsed <= TAP_MS) {
          playQueueItem(snapshot.item);
          suppressClick = true;
        }
      },
      true
    );

    panel.addEventListener(
      "pointercancel",
      () => {
        suppressClick = true;
        clearPress();
      },
      true
    );

    panel.addEventListener(
      "click",
      (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      },
      true
    );

    let keyPress = null;

    panel.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const item = itemFrom(event.target);
        if (!item) return;
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        keyPress = { item, t: performance.now() };
      },
      true
    );

    panel.addEventListener(
      "keyup",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (!keyPress) return;
        const elapsed = performance.now() - keyPress.t;
        const item = keyPress.item;
        keyPress = null;
        if (elapsed < TAP_MS) {
          event.preventDefault();
          playQueueItem(item);
          suppressClick = true;
        }
      },
      true
    );
  }

  function ensureQueueItemMenus() {
    qsa(
      "#side-panel ytmusic-playlist-panel-video-renderer, #side-panel ytmusic-queue-item, #side-panel ytmusic-player-queue-item"
    ).forEach((item) => {
      item.classList.add("deck-queue-menu-visible");
      item.style.setProperty("--ytmusic-menu-renderer-button-opacity", "1");
      item.style.setProperty("--yt-endpoint-action-button-opacity", "1");

      injectQueueItemHostStyle(item);
      ensureQueueActionsRow(item);

      qsa("ytmusic-menu-renderer, ytmusic-item-menu-renderer", item).forEach((menu) => {
        injectQueueMenuShadowStyle(menu);
      });

      forEachShadowRoot(item, (root) => {
        qsa("ytmusic-menu-renderer, ytmusic-item-menu-renderer", root).forEach((menu) => {
          injectQueueMenuShadowStyle(menu);
        });
      });

      mountQueueMenuProxy(item);

      const proxy = qs(".deck-queue-menu-proxy", item.shadowRoot || item);
      if (proxy) alignNativeMenuToProxy(item, proxy);
    });
  }

  function hideClutterOnce() {
    if (clutterHidden) return;
    clutterHidden = true;
    qsa(
      "ytmusic-sign-in-renderer, ytmusic-guide-signin-renderer, #footer, ytmusic-guide-download-app-renderer, #guide-section-wrapper"
    ).forEach((el) => el.classList.add("deck-hidden"));
  }

  function updateDeckUi() {
    syncMediaActiveUi();
    const state = collectState();
    const art = qs(".deck-now-playing-art");
    const artUrl = readArtUrl();
    if (art && artUrl) setHeroArt(art, artUrl);
    syncDeckAccentTheme();

    const titleEl = qs(".deck-now-playing-meta .deck-title");
    const artistEl = qs(".deck-now-playing-meta .deck-artist");
    const barTitle = readSongTitle();
    const barArtist = readSongArtist();
    if (titleEl && barTitle) titleEl.textContent = barTitle;
    if (artistEl && barArtist) artistEl.textContent = barArtist;

    trimHeroUi();

    const queueItems = qsa("ytmusic-queue-item, ytmusic-playlist-panel-video-renderer");
    const subtitle = qs(".deck-queue-subtitle");
    if (subtitle && queueItems.length) {
      const playingIndex = queueItems.findIndex(
        (item) => item.hasAttribute("selected") || item.classList.contains("playing")
      );
      const idx = playingIndex >= 0 ? playingIndex + 1 : 1;
      subtitle.textContent = `Reproduciendo · ${idx} de ${queueItems.length}`;
    }
  }

  function collapseBrowseOverlay() {
    /* No colapsar automáticamente: el usuario usa toggle-player-page-button */
  }

  function fixSidePanelLayout() {
    const content = qs("ytmusic-player-page .content");
    const side = qs("#side-panel");
    const wide = document.documentElement.classList.contains("ytm-deck-wide");
    const heroFlex = wide ? "0 0 34%" : "0 0 44%";
    const queueFlex = wide ? "1 1 66%" : "1 1 56%";
    const hero = qs(".deck-hero-wrap");
    if (hero) {
      hero.style.flex = heroFlex;
      hero.style.maxWidth = wide ? "34%" : "44%";
    }
    if (content) {
      content.style.display = "flex";
      content.style.flex = queueFlex;
      content.style.minWidth = wide ? "340px" : "300px";
      content.style.height = "100%";
      content.style.visibility = "visible";
      content.style.opacity = "1";
      content.style.marginLeft = "0";
    }
    if (side) {
      side.style.flex = "1 1 auto";
      side.style.width = "100%";
      side.style.height = "100%";
      side.style.minHeight = "0";
      side.style.display = "flex";
      side.style.flexDirection = "column";
      side.style.visibility = "visible";
      side.style.opacity = "1";
      side.style.marginLeft = "0";
    }
    const main = qs("#main-panel");
    if (main) main.style.display = "none";
  }

  function fixPlayerPageLayout() {
    const page = qs("ytmusic-player-page");
    if (!page) return;
    page.style.marginLeft = "0";
    page.style.paddingLeft = "0";
    page.style.transform = "none";
    page.style.webkitTransform = "none";
    fixSidePanelLayout();
  }

  function bindSidePanelTabs() {
    const sidePanel = qs("#side-panel");
    if (!sidePanel || sidePanel.dataset.deckTabsBound) return;
    sidePanel.dataset.deckTabsBound = "1";
    sidePanel.addEventListener("click", (event) => {
      if (event.target.closest("tp-yt-paper-tab, paper-tab")) {
        sideTabUserPicked = true;
        setTimeout(paintDeckAccentTabs, 0);
        setTimeout(paintDeckAccentTabs, 120);
      }
    });
  }

  function ensureQueueTab() {
    if (sideTabUserPicked) return;

    const sidePanel = qs("#side-panel");
    if (!sidePanel || !isPlayerPageOpen()) return;

    const selected = qs(
      "#side-panel tp-yt-paper-tab.iron-selected, #side-panel paper-tab.iron-selected"
    );
    if (selected) return;

    const tabs = qsa("#side-panel tp-yt-paper-tab, #side-panel paper-tab");
    const queueTab = tabs.find((tab) => {
      const label = (tab.textContent || "").toLowerCase();
      return /cola|queue|siguiente|continuación|up next|a continuación/.test(label);
    });
    if (queueTab) {
      queueTab.click();
      return;
    }
    if (tabs.length) tabs[0].click();
  }

  function syncPlayingView() {
    if (isPlayerPageOpen()) {
      setPlayingMode(true);
      fixPlayerPageLayout();
      buildHeroUi();
      mountSidePanel();
      ensureQueueTab();
    } else {
      sideTabUserPicked = false;
      setPlayingMode(false);
      removeHeroUi();
    }
    updateDeckUi();
  }

  function bindPlayerToggle() {
    const bar = qs("ytmusic-player-bar");
    if (!bar || bar.dataset.deckToggleBound) return;
    bar.dataset.deckToggleBound = "1";

    bar.addEventListener("click", (event) => {
      if (!event.target.closest(".toggle-player-page-button")) return;
      setTimeout(syncPlayingView, 0);
      setTimeout(syncPlayingView, 300);
      setTimeout(syncPlayingView, 800);
      setTimeout(() => {
        syncPlayingView();
      }, 1500);
    });
  }

  const PLAYER_OPEN_TARGETS =
    ".toggle-player-page-button, .thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer";
  const PLAYER_BAR_INTERACTIVE =
    "yt-icon-button, tp-yt-paper-icon-button, tp-yt-paper-slider, #volume-slider, #progress-bar, button, a.yt-simple-endpoint, .left-controls-buttons, .right-controls-buttons, .middle-controls-buttons, .play-pause-button, .next-button, .previous-button";

  function bindPlayerBarOpenGuard() {
    const bar = qs("ytmusic-player-bar");
    if (!bar || bar.dataset.deckOpenGuard) return;
    bar.dataset.deckOpenGuard = "1";

    const blockAccidentalOpen = (event) => {
      const target = event.target;
      if (target.closest(PLAYER_OPEN_TARGETS)) return;
      if (target.closest(PLAYER_BAR_INTERACTIVE)) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.cancelable) event.preventDefault();
    };

    bar.addEventListener("click", blockAccidentalOpen, true);
    bar.addEventListener("pointerup", blockAccidentalOpen, true);

    bar.addEventListener(
      "click",
      (event) => {
        if (isPlayerPageOpen()) return;
        if (!event.target.closest(".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer")) return;
        const toggle = qs(
          ".toggle-player-page-button button, .toggle-player-page-button yt-icon-button",
          bar
        );
        if (!toggle) return;
        setTimeout(() => {
          if (!isPlayerPageOpen()) click(toggle);
          syncPlayingView();
          setTimeout(syncPlayingView, 300);
        }, 0);
      },
      false
    );
  }

  function fixChips() {
    qsa("ytmusic-chip-cloud-chip-renderer").forEach((chip) => {
      const text = qs("yt-formatted-string.text, .text", chip);
      if (text) {
        text.style.fontSize = "16px";
        text.style.color = "var(--deck-text, #ffffff)";
      }
    });
  }

  function ensureSidebarExpanded() {
    const layout = qs("ytmusic-app-layout");
    if (layout) {
      layout.classList.remove("mini-guide-visible");
      layout.removeAttribute("mini-guide-visible");
      layout.setAttribute("guide-persistent-and-visible", "");
      layout.style.setProperty("--ytmusic-guide-width", "0px");
    }
    const drawer = qs("tp-yt-app-drawer#guide");
    if (drawer) {
      drawer.classList.add("deck-persistent");
      drawer.setAttribute("opened", "");
      drawer.setAttribute("aria-expanded", "true");
      if (typeof drawer.open === "function") {
        try {
          drawer.open();
        } catch (_) {}
      }
      drawer.style.position = "relative";
      drawer.style.transform = "none";
      drawer.style.webkitTransform = "none";
      drawer.style.visibility = "visible";
      drawer.style.width = "100%";
      drawer.style.height = "100%";
      const navW =
        getComputedStyle(document.documentElement).getPropertyValue("--deck-nav-w").trim() || "272px";
      drawer.style.setProperty("--paper-drawer-width", navW);
      drawer.style.overflowX = "hidden";
      drawer.style.overflowY = "auto";
    }
    hideGuideCloseButtons();
    qsa("ytmusic-guide-entry-renderer .title").forEach((el) => {
      el.style.visibility = "visible";
      el.style.display = "inline-block";
      el.style.opacity = "1";
    });
  }

  function hideGuideCloseButtons() {
    qsa(
      "#guide-close-button, .close-button, #close-icon, ytmusic-guide-renderer yt-icon-button.close"
    ).forEach((el) => {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
    });
    qsa("ytmusic-guide-renderer yt-icon-button, #guide-content yt-icon-button").forEach((el) => {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (!/close|cerrar/.test(label)) return;
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("pointer-events", "none", "important");
    });
  }

  function carouselItemsEl(root) {
    return (
      qs("ytmusic-carousel #items", root) ||
      qs("ytmusic-carousel .items-wrapper", root) ||
      qs("#side-panel ytmusic-carousel #items", root)
    );
  }

  function carouselNavDirection(btn) {
    const id = (btn.id || "").toLowerCase();
    const label = (btn.getAttribute?.("aria-label") || btn.title || "").toLowerCase();
    if (id.includes("next") || /next|siguiente|adelante|forward/.test(label)) return 1;
    if (id.includes("prev") || /prev|anterior|atrás|back/.test(label)) return -1;
    const group = btn.closest(".button-group, .content-group, ytmusic-carousel");
    if (!group) return 0;
    const navBtns = qsa(
      "yt-icon-button, tp-yt-paper-icon-button, #previous-items-button, #next-items-button, .previous-items-button, .next-items-button",
      group
    ).filter((el) => !qs("ytmusic-play-button-renderer", el));
    if (navBtns.length < 2) return 0;
    if (navBtns[0] === btn || navBtns[0].contains(btn)) return -1;
    if (navBtns[1] === btn || navBtns[1].contains(btn)) return 1;
    return 0;
  }

  function scrollCarouselBy(btn, direction) {
    const carousel = btn.closest("ytmusic-carousel");
    const shelf =
      btn.closest("ytmusic-carousel-shelf-renderer, ytmusic-shelf-renderer, ytmusic-tab-renderer, ytmusic-queue-tab") ||
      carousel?.parentElement;
    const items = carousel
      ? qs("#items", carousel) || qs(".items-wrapper", carousel)
      : carouselItemsEl(shelf || document);
    if (!items || items.scrollWidth <= items.clientWidth + 4) return false;
    const step = Math.max(220, Math.round(items.clientWidth * 0.72));
    items.scrollBy({ left: step * direction, behavior: "smooth" });
    return true;
  }

  function bindCarouselNav() {
    const selectors =
      "ytmusic-carousel-shelf-renderer .button-group yt-icon-button, ytmusic-carousel-shelf-renderer .button-group tp-yt-paper-icon-button, ytmusic-shelf-renderer .button-group yt-icon-button, #previous-items-button, #next-items-button, .previous-items-button, .next-items-button, #side-panel ytmusic-carousel yt-icon-button, #side-panel ytmusic-carousel tp-yt-paper-icon-button";

    qsa(selectors).forEach((btn) => {
      if (btn.dataset.deckCarouselNav) return;
      btn.dataset.deckCarouselNav = "1";
      btn.style.pointerEvents = "auto";

      const clickTarget = qs("button", btn) || btn;
      clickTarget.addEventListener(
        "click",
        (event) => {
          const dir = carouselNavDirection(btn);
          if (!dir) return;
          if (!scrollCarouselBy(btn, dir)) return;
          event.preventDefault();
          event.stopPropagation();
        },
        true
      );
    });

    qsa("ytmusic-carousel #items, ytmusic-carousel .items-wrapper, #side-panel ytmusic-carousel #items").forEach(
      (items) => {
        items.style.setProperty("overflow-x", "auto", "important");
        items.style.setProperty("overflow-y", "hidden", "important");
        items.style.setProperty("scroll-behavior", "smooth", "important");
      }
    );
  }

  function fixShelfButtonLayout(root = document) {
    qsa("ytmusic-carousel-shelf-renderer, ytmusic-shelf-renderer", root).forEach((shelf) => {
      const buttonGroup = qs(".button-group", shelf);
      const header = qs(".header-group", shelf);
      if (!buttonGroup) return;

      const isCarousel = shelf.tagName === "YTMUSIC-CAROUSEL-SHELF-RENDERER";

      // Deshacer wrappers previos
      qsa(".deck-shelf-nav-row, .deck-shelf-action-row, .deck-shelf-header-nav", buttonGroup).forEach(
        (wrap) => {
          while (wrap.firstChild) buttonGroup.insertBefore(wrap.firstChild, wrap);
          wrap.remove();
        }
      );

      // Devolver play buttons al carrusel si se movieron al header por error
      qsa("ytmusic-play-button-renderer", buttonGroup).forEach((play) => {
        const items = qsa("ytmusic-multi-carousel-item-renderer, ytmusic-two-row-item-renderer", shelf);
        for (const item of items) {
          if (qs("ytmusic-play-button-renderer", item)) continue;
          const target = qs("ytmusic-thumbnail-renderer, .thumbnail-container", item) || item;
          target.appendChild(play);
          break;
        }
      });

      buttonGroup.style.position = "absolute";
      buttonGroup.style.top = "0";
      buttonGroup.style.right = "12px";
      buttonGroup.style.zIndex = "5";
      buttonGroup.style.display = "inline-flex";
      buttonGroup.style.flexDirection = "row";
      buttonGroup.style.alignItems = "center";
      buttonGroup.style.justifyContent = "flex-end";
      buttonGroup.style.gap = "16px";

      if (isCarousel) {
        buttonGroup.style.flexWrap = "wrap";
        buttonGroup.style.rowGap = "48px";
        buttonGroup.style.width = "108px";
      } else {
        buttonGroup.style.flexWrap = "nowrap";
        buttonGroup.style.rowGap = "0";
        buttonGroup.style.width = "auto";
      }

      qsa(
        "yt-icon-button, tp-yt-paper-icon-button, ytmusic-button-renderer, ytmusic-navigation-button-renderer",
        buttonGroup
      ).forEach((ctrl) => {
        ctrl.style.setProperty("position", "relative", "important");
        ctrl.style.setProperty("top", "auto", "important");
        ctrl.style.setProperty("right", "auto", "important");
        ctrl.style.setProperty("left", "auto", "important");
        ctrl.style.setProperty("bottom", "auto", "important");
        ctrl.style.setProperty("inset", "auto", "important");
        ctrl.style.setProperty("transform", "none", "important");
        ctrl.style.setProperty("margin", "0", "important");
      });

      if (header) {
        const groupRect = buttonGroup.getBoundingClientRect();
        header.style.paddingRight = `${Math.max(isCarousel ? 200 : 160, Math.ceil(groupRect.width) + 24)}px`;
        header.style.minHeight = `${Math.max(isCarousel ? 132 : 52, Math.ceil(groupRect.height) + 12)}px`;
      }
    });
  }

  function fixCarouselText() {
    const wrappers =
      "ytmusic-multi-carousel-item-renderer .text-wrapper, ytmusic-multi-carousel-item-renderer .title-wrapper, ytmusic-multi-carousel-item-renderer .subtitle-wrapper, ytmusic-two-row-item-renderer .text-wrapper, ytmusic-two-row-item-renderer .column-content, ytmusic-two-row-item-renderer .title-group, ytmusic-two-row-item-renderer .subtitle-group";
    qsa(wrappers).forEach((el) => {
      el.style.setProperty("max-height", "fit-content", "important");
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("overflow", "visible", "important");
    });

    qsa("ytmusic-carousel, ytmusic-multi-carousel-item-renderer, ytmusic-two-row-item-renderer").forEach(
      (el) => {
        el.style.setProperty("height", "auto", "important");
        el.style.setProperty("max-height", "none", "important");
      }
    );

    qsa("ytmusic-carousel #items, ytmusic-carousel .items-wrapper, #side-panel ytmusic-carousel #items").forEach(
      (el) => {
        el.style.setProperty("overflow-x", "auto", "important");
        el.style.setProperty("overflow-y", "hidden", "important");
        el.style.removeProperty("overflow");
      }
    );

    qsa(
      "ytmusic-browse-response ytmusic-multi-carousel-item-renderer .title, ytmusic-browse-response ytmusic-multi-carousel-item-renderer .subtitle, ytmusic-browse-response ytmusic-two-row-item-renderer .title, ytmusic-browse-response ytmusic-two-row-item-renderer .subtitle, ytmusic-browse-response ytmusic-two-row-item-renderer .byline"
    ).forEach((el) => {
      el.style.setProperty("display", "block", "important");
      el.style.setProperty("max-height", "fit-content", "important");
      el.style.setProperty("overflow", "visible", "important");
      el.style.setProperty("-webkit-line-clamp", "unset", "important");
      el.style.setProperty("line-clamp", "unset", "important");
      el.style.setProperty("white-space", "normal", "important");
      el.style.setProperty("text-overflow", "clip", "important");
      el.style.removeProperty("height");
    });

    qsa(
      "ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer .title, ytmusic-carousel-shelf-renderer ytmusic-responsive-list-item-renderer .title"
    ).forEach((el) => {
      el.style.setProperty("font-size", "var(--deck-fs-item-title)", "important");
      el.style.setProperty("font-weight", "600", "important");
      el.style.setProperty("line-height", "1.35", "important");
      el.style.setProperty("margin-bottom", "0", "important");
      el.style.removeProperty("height");
      el.style.removeProperty("max-height");
    });
  }

  function fixLibraryTabs() {
    qsa("ytmusic-browse-response ytmusic-tabs").forEach((tabs) => {
      tabs.style.setProperty("background", "transparent", "important");
      tabs.style.setProperty("background-color", "transparent", "important");
      tabs.style.setProperty("box-shadow", "none", "important");
      tabs.style.setProperty("position", "relative", "important");
      tabs.style.setProperty("top", "0", "important");
      tabs.style.setProperty("margin-top", "0", "important");
      tabs.style.setProperty("margin-bottom", "10px", "important");
      tabs.style.setProperty("padding-top", "0", "important");
      tabs.style.setProperty("z-index", "1", "important");
      tabs.style.setProperty("transform", "none", "important");
    });

    qsa("ytmusic-browse-response .background-gradient").forEach((el) => {
      el.style.setProperty("background", "transparent", "important");
      el.style.setProperty("background-color", "transparent", "important");
      el.style.setProperty("background-image", "none", "important");
    });
  }

  function fixContentOffset() {
    const content = qs("#content");
    if (content) {
      content.style.marginLeft = "0";
      content.style.paddingLeft = "0";
      content.style.transform = "none";
    }
    const browse = qs("ytmusic-browse-response");
    if (browse) {
      browse.style.marginLeft = "0";
      const bStyle = getComputedStyle(browse);
      const padL = parseFloat(bStyle.paddingLeft) || 0;
      const padR = parseFloat(bStyle.paddingRight) || 0;
      const innerW = Math.max(0, browse.getBoundingClientRect().width - padL - padR);
      const setInnerWidth = (el) => {
        el.style.width = `${innerW}px`;
        el.style.maxWidth = `${innerW}px`;
        el.style.boxSizing = "border-box";
      };
      qsa("ytmusic-browse-response > div", document).forEach(setInnerWidth);
      qsa(
        "ytmusic-single-column-browse-results-renderer, ytmusic-section-list-renderer, ytmusic-tab-renderer, ytmusic-carousel-shelf-renderer, ytmusic-shelf-renderer",
        browse
      ).forEach((el) => {
        el.style.marginLeft = "0";
        el.style.paddingLeft = "0";
        setInnerWidth(el);
      });
      qsa(
        "ytmusic-chip-cloud-renderer, .header-group, .content-group, ytmusic-carousel ul",
        browse
      ).forEach((el) => {
        el.style.marginLeft = "0";
        el.style.marginRight = "0";
      });
      qsa("ytmusic-carousel-shelf-renderer .button-group, ytmusic-shelf-renderer .button-group", browse).forEach(
        (el) => {
          el.style.right = "12px";
          el.style.marginRight = "0";
        }
      );
      fixShelfButtonLayout(browse);
    }
    fixLibraryTabs();
    fixCarouselText();
    const layout = qs("ytmusic-app-layout");
    if (layout) {
      layout.style.setProperty("--ytmusic-guide-width", "0px");
    }
  }

  function bindPlayerBarThumbnailEvents() {
    const bar = qs("ytmusic-player-bar");
    if (!bar || bar.dataset.deckThumbBound === "1") return;
    bar.dataset.deckThumbBound = "1";
    bar.addEventListener(
      "load",
      (event) => {
        if (event.target.tagName === "IMG") syncPlayerBarThumbnail();
      },
      true
    );
    bar.addEventListener(
      "error",
      (event) => {
        if (event.target.tagName === "IMG") syncPlayerBarThumbnail();
      },
      true
    );
  }

  function fixPlayerBar() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return;
    bar.style.visibility = "visible";
    bar.style.opacity = "1";
    bar.style.transform = "none";
    bindPlayerBarThumbnailEvents();
    fixPlayerBarProgress();
    fixPlayerBarVolume();
  }

  function applyProgressKnobStyle(knob) {
    if (!knob) return;
    const trackHalf = 1.5;
    const knobHalf = 9;
    knob.style.setProperty("top", `${trackHalf}px`, "important");
    knob.style.setProperty("margin-top", `-${knobHalf}px`, "important");
    knob.style.setProperty("margin-left", `-${knobHalf}px`, "important");
  }

  function applyVolumeKnobStyle(slider) {
    const knob = qs("#sliderKnob, .slider-knob", slider);
    const container = qs("#sliderKnobContainer", slider);
    if (!knob || !container) return;
    const half = 7;
    knob.style.setProperty("top", "50%", "important");
    knob.style.setProperty("margin-top", `-${half}px`, "important");
    knob.style.setProperty("margin-left", `-${half}px`, "important");

    const trackW = container.clientWidth;
    if (trackW > 0) {
      const maxLeft = trackW - half;
      const leftPx = parseFloat(getComputedStyle(knob).left);
      if (Number.isFinite(leftPx) && leftPx > maxLeft) {
        knob.style.setProperty("left", `${maxLeft}px`, "important");
      }
    }
  }

  function fixPlayerBarVolume() {
    const slider = qs("ytmusic-player-bar #volume-slider, ytmusic-player-bar tp-yt-paper-slider.volume-slider");
    const right = qs("ytmusic-player-bar .right-controls");
    const buttons = qs("ytmusic-player-bar .right-controls-buttons");
    if (!slider || !right || !buttons) return;

    if (slider.parentElement !== right || slider.nextElementSibling !== buttons) {
      right.insertBefore(slider, buttons);
    }

    Object.assign(slider.style, {
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    });

    ["top", "marginTop", "transform", "padding", "height", "minHeight"].forEach((prop) => {
      const progress = qs("tp-yt-paper-progress", slider);
      if (progress) progress.style.removeProperty(prop);
      const knobContainer = qs("#sliderKnobContainer", slider);
      if (knobContainer) knobContainer.style.removeProperty(prop);
    });

    applyVolumeKnobStyle(slider);
  }

  function fixPlayerBarProgress() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return;

    const active = syncMediaActiveUi();

    const progress =
      qs("#progress-bar", bar) ||
      qs("tp-yt-paper-slider#progress-bar", bar) ||
      qs(".progress-bar-wrapper #progress-bar", bar);

    bar.style.position = "relative";
    bar.style.overflow = "visible";
    bar.style.paddingTop = active ? "10px" : "0";

    if (!active) {
      if (progress) progress.style.display = "none";
      const wrap = qs(".progress-bar-wrapper", bar);
      if (wrap) wrap.style.display = "none";
      return;
    }

    if (progress) {
      progress.style.display = "block";
      const leftInset = 42;
      const rightInset = 42;
      const knobHalf = 9;
      const trackWidth = Math.max(0, bar.offsetWidth - leftInset - rightInset);
      Object.assign(progress.style, {
        position: "absolute",
        top: "0",
        left: `${leftInset}px`,
        right: "auto",
        width: `${trackWidth}px`,
        height: "18px",
        margin: "0",
        padding: `0 ${knobHalf}px`,
        overflow: "visible",
        transform: "none",
        zIndex: "6",
        boxSizing: "border-box",
      });

      const container = qs("#sliderContainer", progress);
      if (container) {
        Object.assign(container.style, {
          width: "100%",
          height: "18px",
          margin: "0",
          padding: "0",
          left: "0",
          top: "0",
          overflow: "visible",
        });
      }

      const knob = qs("#sliderKnob, .slider-knob", progress);
      applyProgressKnobStyle(knob);
    }

    const wrap = qs(".progress-bar-wrapper", bar);
    if (wrap) {
      wrap.style.display = "block";
      const leftInset = 42;
      const rightInset = 42;
      const trackWidth = Math.max(0, bar.offsetWidth - leftInset - rightInset);
      Object.assign(wrap.style, {
        position: "absolute",
        top: "0",
        left: `${leftInset}px`,
        right: "auto",
        width: `${trackWidth}px`,
        margin: "0",
        padding: "0",
        display: "block",
        zIndex: "6",
      });
    }

    qsa(".time-info", bar).forEach((el) => {
      el.style.display = "none";
    });
  }

  function applyDeckLayout() {
    applyViewportMetrics();
    ensureDeckClass();
    hideClutterOnce();
    collapseBrowseOverlay();
    ensureSidebarExpanded();
    fixChips();
    fixContentOffset();
    fixPlayerBar();
    ensureAccountMenuAccess();
    ensureQueueItemMenus();
    bindCarouselNav();
    bindQueuePanelTouch();
    bindDeckInput();
    bindPlayerToggle();
    bindPlayerBarOpenGuard();

    if (isPlayerPageOpen()) {
      setPlayingMode(true);
      fixPlayerPageLayout();
      buildHeroUi();
      mountSidePanel();
      ensureQueueTab();
    } else {
      sideTabUserPicked = false;
      setPlayingMode(false);
      removeHeroUi();
    }

    updateDeckUi();
    deckUiReady = true;
  }

  function scheduleLayout() {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(applyDeckLayout, 400);
  }

  function handleCommand(command, data) {
    const video = getVideo();
    switch (command) {
      case "play":
        if (video) video.play();
        else click("ytmusic-player-bar .play-pause-button");
        break;
      case "pause":
        if (video) video.pause();
        else click("ytmusic-player-bar .play-pause-button");
        break;
      case "playPause":
        click("ytmusic-player-bar .play-pause-button");
        break;
      case "next":
        click('ytmusic-player-bar .next-button, ytmusic-player-bar [aria-label*="Next"], ytmusic-player-bar [aria-label*="Siguiente"]');
        break;
      case "previous":
        click('ytmusic-player-bar .previous-button, ytmusic-player-bar [aria-label*="Previous"], ytmusic-player-bar [aria-label*="Anterior"]');
        break;
      case "seek":
        if (video)
          video.currentTime = Math.max(0, video.currentTime + Number(data.offsetUs || 0) / 1_000_000);
        break;
      case "setPosition":
        if (video) video.currentTime = Number(data.positionUs || 0) / 1_000_000;
        break;
      case "setVolume":
        if (video && Number.isFinite(Number(data.volume)))
          video.volume = Math.min(1, Math.max(0, Number(data.volume)));
        break;
      case "setShuffle":
        click('ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]');
        break;
      case "setLoop":
        click('ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]');
        break;
      case "activate":
        deckActivate();
        break;
      case "back":
        deckBack();
        break;
      default:
        break;
    }
    setTimeout(() => {
      scheduleLayout();
      reportState();
    }, 200);
  }

  function bindVideoEvents() {
    const video = getVideo();
    if (!video || video.dataset.deckBound) return;
    video.dataset.deckBound = "1";
    video.addEventListener("play", scheduleLayout);
    video.addEventListener("pause", scheduleLayout);
    video.addEventListener("loadedmetadata", scheduleLayout);
    video.addEventListener("timeupdate", updateDeckUi);
    video.addEventListener("volumechange", updateDeckUi);
  }

  function observeDom() {
    if (domObserver) return;
    domObserver = new MutationObserver(() => {
      if (observerTimer) clearTimeout(observerTimer);
      observerTimer = setTimeout(() => {
        scheduleLayout();
        bindVideoEvents();
        ensureQueueItemMenus();
        if (activeQueueMenuProxy) repositionQueuePopups(activeQueueMenuProxy);
      }, 800);
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function start() {
    if (window.__YTM_DECK_STARTED__) {
      applyDeckLayout();
      return;
    }
    window.__YTM_DECK_STARTED__ = true;

    applyDeckLayout();
    bindVideoEvents();
    bindPlayerToggle();
    bindPlayerBarOpenGuard();
    bindDeckInput();
    bindQueuePanelTouch();
    observeDom();

    if (!pollTimer) {
      pollTimer = setInterval(() => {
        updateDeckUi();
        reportState();
        bindVideoEvents();
        fixPlayerBarProgress();
        fixPlayerBarVolume();
        fixLibraryTabs();
        fixCarouselText();
        paintDeckAccentSurfaces();
        paintDeckAccentTabs();
        ensureAccountMenuAccess();
        ensureQueueItemMenus();
        bindCarouselNav();
        if (activeQueueMenuProxy) repositionQueuePopups(activeQueueMenuProxy);
      }, POLL_MS);
    }

    if (!layoutInterval) {
      layoutInterval = setInterval(scheduleLayout, 5000);
    }

    window.addEventListener("resize", () => {
      applyViewportMetrics();
      scheduleLayout();
    });
  }

  return {
    start,
    handleCommand,
    applyDeckLayout,
    scheduleLayout,
    collectState,
    get ready() {
      return deckUiReady;
    },
  };
})();
