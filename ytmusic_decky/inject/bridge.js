/**
 * Bridge JavaScript — modo Deck morado, táctil, MPRIS
 * Regla: NUNCA ocultar contenido de browse salvo reproductor expandido visible.
 */
window.YTMDeck = (function () {
  const POLL_MS = 3500;
  const POLL_HEAVY_EVERY = 3;
  const SCROLL_DRAG_THRESHOLD = 10;
  const SCROLL_AXIS_RATIO = 1.15;
  const SCROLL_DRAG_SUPPRESS_MS = 380;
  const QUEUE_LONG_PRESS_MS = 750;
  const QUEUE_MOVE_SLOP = 14;
  const QUEUE_REORDER_MAX_MOVE = 6;
  const QUEUE_VERTICAL_CANCEL = 5;
  const QUEUE_EDGE_SCROLL_PX = 72;
  const QUEUE_EDGE_SCROLL_STEP = 22;
  const QUEUE_TAP_MS = 320;
  const DESIGN_W = 1280;
  const DESIGN_H = 800;
  const WIDE_ASPECT = 1.55;
  const WIDE_FIXED_SCALE = 1.35;
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
  let pollTick = 0;
  let guideMetricsTimer = null;
  const touchResetHooks = [];

  function registerTouchReset(fn) {
    if (typeof fn === "function") touchResetHooks.push(fn);
  }

  function releaseAllPointerCaptures() {
    const nodes = new Set();
    [
      document.documentElement,
      document.body,
      qs("#content"),
      qs("ytmusic-browse-response"),
      qs("#side-panel"),
      qs("#side-panel ytmusic-queue-tab"),
      qs("#side-panel ytmusic-tab-renderer"),
      qs("#guide-content"),
      qs("tp-yt-app-drawer#guide"),
      ...qsa("ytmusic-carousel #items, ytmusic-carousel .items-wrapper"),
    ].forEach((node) => {
      if (node) nodes.add(node);
    });
    nodes.forEach((node) => {
      if (typeof node.releasePointerCapture !== "function") return;
      for (let id = 1; id <= 12; id++) {
        try {
          node.releasePointerCapture(id);
        } catch (_) {
          /* noop */
        }
      }
    });
  }

  let overlayInputSuppressUntil = 0;
  let overlayFreezeTimer = null;

  function suppressOverlayInput(ms) {
    overlayInputSuppressUntil = Math.max(
      overlayInputSuppressUntil,
      performance.now() + Math.max(200, Number(ms) || 600)
    );
    const root = document.documentElement;
    root.classList.add("ytm-deck-input-freeze");
    if (overlayFreezeTimer) clearTimeout(overlayFreezeTimer);
    const left = Math.max(0, overlayInputSuppressUntil - performance.now()) + 40;
    overlayFreezeTimer = setTimeout(() => {
      overlayFreezeTimer = null;
      if (!isOverlayInputSuppressed()) {
        root.classList.remove("ytm-deck-input-freeze");
      }
    }, left);
  }

  function isOverlayInputSuppressed() {
    return performance.now() < overlayInputSuppressUntil;
  }

  function clearPressedUi() {
    try {
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === "function") {
        active.blur();
      }
    } catch (_) {
      /* noop */
    }
    try {
      window.getSelection?.()?.removeAllRanges?.();
    } catch (_) {
      /* noop */
    }
  }

  function resetTouchState(_reason) {
    for (const fn of touchResetHooks) {
      try {
        fn();
      } catch (_) {
        /* noop */
      }
    }
    releaseAllPointerCaptures();
    clearPressedUi();
    setQueueReordering(false);
    document.documentElement.classList.remove("ytm-deck-dragging");
    // Menú Steam / Decky: evita reenviar el último toque al volver el foco.
    if (
      _reason === "lifecycle-hide" ||
      _reason === "lifecycle-focus" ||
      _reason === "qt-focus" ||
      _reason === "qt-inactive" ||
      _reason === "qt-active"
    ) {
      const hide =
        _reason === "lifecycle-hide" || _reason === "qt-inactive";
      suppressOverlayInput(hide ? 1200 : 800);
    }
  }

  function bindOverlayClickGuard() {
    if (window.__YTM_DECK_OVERLAY_GUARD__) return;
    window.__YTM_DECK_OVERLAY_GUARD__ = true;

    const block = (event) => {
      if (!isOverlayInputSuppressed()) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    [
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
      "mousedown",
      "mouseup",
      "pointerdown",
      "pointerup",
      "touchstart",
      "touchend",
      "touchcancel",
    ].forEach((type) => {
      document.addEventListener(type, block, true);
    });
    document.addEventListener(
      "pointercancel",
      () => resetTouchState("pointercancel"),
      true
    );
  }

  function bindAppLifecycleTouchReset() {
    if (window.__YTM_DECK_TOUCH_LIFECYCLE__) return;
    window.__YTM_DECK_TOUCH_LIFECYCLE__ = true;

    const onHide = () => resetTouchState("lifecycle-hide");
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") onHide();
      else resetTouchState("lifecycle-focus");
    });
    window.addEventListener("blur", onHide);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("freeze", onHide);
    window.addEventListener("focus", () => resetTouchState("lifecycle-focus"));
    bindOverlayClickGuard();
  }

  function bindTouchCursorHide() {
    if (window.__YTM_DECK_TOUCH_CURSOR_HIDE__) return;
    if (
      !window.__YTM_DECK_TOUCH__ &&
      !window.__YTM_DECK_STEAM__ &&
      !window.matchMedia("(pointer: coarse)").matches
    ) {
      return;
    }
    window.__YTM_DECK_TOUCH_CURSOR_HIDE__ = true;
    const hide = () => {
      document.documentElement.style.setProperty("cursor", "none", "important");
      if (document.body) document.body.style.setProperty("cursor", "none", "important");
    };
    document.addEventListener("touchstart", hide, { capture: true, passive: true });
    document.addEventListener("pointerdown", hide, { capture: true, passive: true });
  }

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

  /** Reproductor expandido: estado real del DOM de YTM (no la clase deck). */
  function isPlayerPageOpen() {
    const bar = qs("ytmusic-player-bar");
    const page = qs("ytmusic-player-page, #player-page");
    try {
      if (typeof bar?.playerPageOpen === "boolean") return bar.playerPageOpen;
      if (typeof page?.playerPageOpen === "boolean") return page.playerPageOpen;
    } catch (_) {
      /* noop */
    }

    const btn = qs(
      "ytmusic-player-bar .toggle-player-page-button yt-icon-button, ytmusic-player-bar .toggle-player-page-button button"
    );
    if (btn) {
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (/cerrar|close|collapse|contraer/.test(aria)) return true;
      if (/expand|abrir|open|mostrar|ampliar|maximizar/.test(aria)) return false;
    }

    if (!page || !isVisible(page)) return false;
    const rect = page.getBoundingClientRect();
    return rect.width > 120 && rect.height > 120;
  }

  function getPlayerPageToggleButton(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return null;
    return (
      qs(".toggle-player-page-button yt-icon-button", bar) ||
      qs(".toggle-player-page-button tp-yt-paper-icon-button", bar) ||
      qs(".toggle-player-page-button button", bar)
    );
  }

  function markPlayerToggleProgrammatic(ms) {
    window.__YTM_DECK_IGNORE_PLAYER_TOGGLE__ = performance.now() + (ms || 900);
  }

  function isPlayerToggleProgrammatic() {
    return performance.now() < (window.__YTM_DECK_IGNORE_PLAYER_TOGGLE__ || 0);
  }

  function dispatchNativeClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      view: window,
    };
    const pointer = { ...base, pointerId: 1, pointerType: "touch", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("click", base));
  }

  function enterPlayingViewForced() {
    setPlayingMode(true);
    fixPlayerPageLayout();
    buildHeroUi();
    mountSidePanel();
    ensureQueueTab();
    updateDeckUi();
  }

  function exitPlayingViewForced() {
    sideTabUserPicked = false;
    setPlayingMode(false);
    removeHeroUi();
    updateDeckUi();
  }

  function openPlayerPage() {
    markPlayerToggleProgrammatic(1000);
    window.__YTM_DECK_PLAYER_CLOSED_UNTIL__ = 0;
    window.__YTM_DECK_SKIP_WATCH_HISTORY__ = false;

    if (isPlayerPageOpen()) {
      syncPlayingView();
      return true;
    }

    const bar = qs("ytmusic-player-bar");
    const btn = getPlayerPageToggleButton(bar);
    // Un solo click: pointer+click duplicado reabre/minimiza en bucle.
    if (btn) {
      try {
        btn.click();
      } catch (_) {
        dispatchNativeClick(btn);
      }
    }

    setTimeout(syncPlayingView, 250);
    setTimeout(syncPlayingView, 700);
    return true;
  }

  function closePlayerPage() {
    markPlayerToggleProgrammatic(1000);
    window.__YTM_DECK_PLAYER_CLOSED_UNTIL__ = performance.now() + 6000;

    const pageOpen = isPlayerPageOpen();
    const bar = qs("ytmusic-player-bar");
    const page = qs("ytmusic-player-page");
    const polyOpen = !!(bar?.playerPageOpen || page?.playerPageOpen);
    const deckPlaying = document.documentElement.classList.contains("ytm-deck-playing");
    if (!pageOpen && !deckPlaying && !polyOpen) return false;

    // Si cerramos desde /watch, YTM empuja browse encima del watch.
    // El próximo B debe saltar esa entrada watch (go(-2)), no history.back().
    const closingFromWatch = /\/watch/.test(location.pathname || "");

    if (pageOpen || polyOpen) {
      let closed = false;
      try {
        if (page && typeof page.onCollapseButtonClick === "function") {
          page.onCollapseButtonClick();
          closed = true;
        }
      } catch (_) {
        closed = false;
      }
      if (!closed) {
        const btn = getPlayerPageToggleButton(bar);
        if (btn) {
          try {
            btn.click();
          } catch (_) {
            dispatchNativeClick(btn);
          }
        }
      }
    }

    if (closingFromWatch) {
      window.__YTM_DECK_SKIP_WATCH_HISTORY__ = true;
      try {
        clearTimeout(window.__YTM_DECK_SKIP_WATCH_TIMER__);
      } catch (_) {}
      window.__YTM_DECK_SKIP_WATCH_TIMER__ = setTimeout(() => {
        window.__YTM_DECK_SKIP_WATCH_HISTORY__ = false;
      }, 15000);
    }

    exitPlayingViewForced();
    setTimeout(syncPlayingView, 350);
    setTimeout(() => {
      ensureSidebarExpanded();
      ensureGuideScrollLayout();
    }, 400);
    return true;
  }

  function togglePlayerPageView() {
    if (isPlayerPageOpen() || qs("ytmusic-player-bar")?.playerPageOpen) {
      return closePlayerPage();
    }
    return openPlayerPage();
  }

  function navigateHistoryBack() {
    if (window.__YTM_DECK_SKIP_WATCH_HISTORY__) {
      window.__YTM_DECK_SKIP_WATCH_HISTORY__ = false;
      try {
        clearTimeout(window.__YTM_DECK_SKIP_WATCH_TIMER__);
      } catch (_) {}
      // [browse, watch, browse] → saltar watch para no reanimar el toggle.
      if (history.length > 1) {
        history.go(-2);
        return;
      }
    }
    if (history.length > 1) {
      history.back();
    }
  }

  function isPlayingView() {
    if (isPlayerPageOpen()) return true;

    const sidePanel = qs("#side-panel");
    if (sidePanel && isVisible(sidePanel)) return true;

    return false;
  }

  function readText(sel, root) {
    const el = root ? (root.querySelector ? root.querySelector(sel) : null) : qs(sel);
    return el ? (el.textContent || "").trim() : "";
  }

  function cleanArtistText(text) {
    if (!text) return "";
    const t = text.replace(/\s+/g, " ").trim();
    if (/^e$/i.test(t)) return "";
    return t;
  }

  function parseArtistLabel(text) {
    const t = cleanArtistText(text);
    if (!t) return "";
    return t.split("•")[0].trim();
  }

  function extractArtistFromByline(el) {
    if (!el) return "";
    if (el.matches?.("yt-formatted-string.byline, yt-formatted-string.subtitle, .byline, .subtitle")) {
      const direct = parseArtistLabel(el.textContent || "");
      if (direct) return direct;
    }
    const links = qsa("a.yt-simple-endpoint, yt-formatted-string", el);
    for (const node of links) {
      if (node.closest("ytmusic-inline-badge-renderer, ytmusic-badge-supported-renderer")) continue;
      const t = parseArtistLabel(node.textContent || "");
      if (t) return t;
    }
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll(
        "ytmusic-inline-badge-renderer, ytmusic-badge-supported-renderer, ytmusic-badge-renderer, [class*='badge']"
      )
      .forEach((node) => node.remove());
    return parseArtistLabel(clone.textContent || "");
  }

  function readQueueArtist() {
    const selectors = [
      "ytmusic-queue-item[selected] .byline",
      "ytmusic-playlist-panel-video-renderer[selected] .byline",
      "ytmusic-player-queue-item[selected] .byline",
      "ytmusic-queue-item[selected] .subtitle",
      "ytmusic-playlist-panel-video-renderer[selected] .subtitle",
      "ytmusic-queue-item[selected] yt-formatted-string.byline",
      "ytmusic-playlist-panel-video-renderer[selected] yt-formatted-string.byline",
    ];
    for (const sel of selectors) {
      const text = parseArtistLabel(readText(sel));
      if (text) return text;
    }
    return "";
  }

  function readLivePlayerBarArtist(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return "";

    const bylineSelectors = [
      ".middle-controls .byline",
      ".middle-controls .content-info-wrapper .byline",
      ".middle-controls .song-info .byline",
      ".left-controls .content-info-wrapper .byline",
      ".left-controls .song-info .byline",
      ".left-controls .byline",
      ".left-controls .subtitle",
      ".song-info .byline",
      ".content-info-wrapper .byline",
    ];
    for (const sel of bylineSelectors) {
      const text = extractArtistFromByline(qs(sel, bar));
      if (text) return text;
    }

    return readQueueArtist();
  }

  function readMarqueeTitle(root) {
    if (!root) root = document;
    const marquee = qs(".deck-title-marquee[data-deck-original-text]", root);
    if (marquee?.dataset.deckOriginalText?.trim()) {
      return marquee.dataset.deckOriginalText.trim();
    }
    const primary = qs(".deck-title-marquee-text", root);
    if (primary?.textContent?.trim()) return primary.textContent.trim();
    return "";
  }

  function readLivePlayerBarTitle(bar, opts) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return "";

    if (!opts?.skipDeckMedia) {
      const fromDeckMedia = readText(".deck-media-title", bar);
      if (fromDeckMedia) return fromDeckMedia;

      const fromMarquee = readMarqueeTitle(bar);
      if (fromMarquee) return fromMarquee;
    }

    const titleSelectors = [
      ".middle-controls .title",
      ".middle-controls .song-info .title",
      ".left-controls .content-info-wrapper .title",
      ".left-controls .song-info .title",
      ".middle-controls .title yt-formatted-string",
      ".left-controls .title yt-formatted-string",
      ".left-controls .title a.yt-simple-endpoint",
      ".middle-controls .title a.yt-simple-endpoint",
    ];
    for (const sel of titleSelectors) {
      const el = qs(sel, bar);
      if (!el || el.closest(".deck-media-title, .deck-title-marquee")) continue;
      const text = (el.textContent || "").trim();
      if (text) return text;
    }

    const fromQueue = readText(
      "ytmusic-queue-item[selected] .song-title, ytmusic-playlist-panel-video-renderer[selected] .song-title"
    );
    if (fromQueue) return fromQueue;

    return "";
  }

  function readBarTitle() {
    const live = readLivePlayerBarTitle();
    if (live) return live;
    return (
      readText("ytmusic-player-bar .song-info .title") ||
      readText("ytmusic-player-bar .middle-controls .title") ||
      readText("ytmusic-player-bar .title")
    );
  }

  function readBarArtist() {
    const live = readLivePlayerBarArtist();
    if (live) return live;
    return cleanArtistText(
      readText("ytmusic-player-bar .left-controls .song-info .byline") ||
        readText("ytmusic-player-bar .left-controls .content-info-wrapper .byline") ||
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

  function readMediaSessionMeta() {
    try {
      const meta = navigator.mediaSession?.metadata;
      if (!meta) return { title: "", artist: "", album: "", artUrl: "" };
      let artUrl = "";
      const arts = meta.artwork || [];
      if (arts.length) {
        const sorted = [...arts].sort(
          (a, b) => (Number(b.sizes?.split?.("x")?.[0]) || 0) - (Number(a.sizes?.split?.("x")?.[0]) || 0)
        );
        artUrl = sorted[0]?.src || arts[arts.length - 1]?.src || "";
      }
      return {
        title: (meta.title || "").trim(),
        artist: (meta.artist || "").trim(),
        album: (meta.album || "").trim(),
        artUrl: artUrl ? upscaleArtUrl(artUrl) : "",
      };
    } catch (_) {
      return { title: "", artist: "", album: "", artUrl: "" };
    }
  }

  function queryInTree(root, selectors) {
    if (!root) return null;
    let found = null;
    const list = Array.isArray(selectors) ? selectors : [selectors];
    forEachShadowRoot(root, (node) => {
      if (found) return;
      for (const sel of list) {
        const el = qs(sel, node);
        if (el) {
          found = el;
          return;
        }
      }
    });
    return found;
  }

  function textInTree(root, selectors) {
    const el = queryInTree(root, selectors);
    return el ? (el.textContent || "").trim() : "";
  }

  function readPlayerBarTitleDeep() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return "";
    return (
      textInTree(bar, [
        ".deck-media-title",
        ".deck-title-marquee[data-deck-original-text]",
        ".title yt-formatted-string",
        ".title a",
        ".title",
        "yt-formatted-string.title",
      ]) ||
      (qs(".deck-title-marquee[data-deck-original-text]", bar)?.dataset?.deckOriginalText || "").trim() ||
      ""
    );
  }

  function readPlayerBarArtistDeep() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return "";
    const raw =
      textInTree(bar, [
        ".byline yt-formatted-string",
        ".byline a",
        ".byline",
        ".subtitle",
      ]) || "";
    return parseArtistLabel(raw);
  }

  function readArtUrlDeep() {
    const pick = (img) => {
      if (!img) return "";
      const url = img.currentSrc || img.src || "";
      if (!url || url.startsWith("data:")) return "";
      return upscaleArtUrl(url);
    };
    const bar = qs("ytmusic-player-bar");
    if (bar) {
      const img = queryInTree(bar, [
        ".thumbnail-image-wrapper img",
        "ytmusic-thumbnail-renderer img",
        "yt-img-shadow img",
        "img.image",
        "img",
      ]);
      const url = pick(img);
      if (url) return url;
    }
    const page = qs("ytmusic-player-page");
    if (page) {
      const img = queryInTree(page, ["#song-image img", "ytmusic-thumbnail-renderer img", "img"]);
      const url = pick(img);
      if (url) return url;
    }
    return "";
  }

  function readDocumentTitleMeta() {
    const raw = (document.title || "").replace(/\s*-\s*YouTube Music\s*$/i, "").trim();
    if (!raw || /^youtube music$/i.test(raw)) return { title: "", artist: "" };
    const parts = raw.split(/\s+[•·|]\s+/);
    if (parts.length >= 2) {
      return { title: parts[0].trim(), artist: parts.slice(1).join(" • ").trim() };
    }
    return { title: raw, artist: "" };
  }

  function readSongTitle() {
    if (isAdPlaying()) {
      const queueTitle = readText(
        "ytmusic-queue-item[selected] .song-title, ytmusic-playlist-panel-video-renderer[selected] .song-title"
      );
      if (queueTitle) return queueTitle;
    }
    const bar = readBarTitle() || readPlayerBarTitleDeep();
    if (bar) return bar;
    const deck = readText(".deck-now-playing-meta .deck-title");
    if (deck) return deck;
    const ms = readMediaSessionMeta().title;
    if (ms) return ms;
    return readDocumentTitleMeta().title;
  }

  function readSongArtist() {
    const live = readLivePlayerBarArtist() || readPlayerBarArtistDeep();
    if (live) return live;

    const queueArtist = readQueueArtist();
    if (queueArtist) return queueArtist;

    if (isAdPlaying()) return "";

    const bar = readBarArtist();
    if (bar) return bar;
    const deck = readText(".deck-now-playing-meta .deck-artist");
    if (deck) return deck;
    const ms = readMediaSessionMeta().artist;
    if (ms) return ms;
    return readDocumentTitleMeta().artist;
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
    const deep = readArtUrlDeep();
    if (deep) return deep;

    const pick = (img) => {
      if (!img) return "";
      const url = img.currentSrc || img.src || "";
      if (!url || url.startsWith("data:")) return "";
      return upscaleArtUrl(url);
    };

    const bar = qs("ytmusic-player-bar");
    const candidates = [];
    if (bar) {
      candidates.push(
        qs(".thumbnail-image-wrapper img", bar),
        qs("img.image", bar),
        qs(".song-image img", bar),
        qs("yt-img-shadow img", bar),
        qs("img", bar)
      );
    }
    candidates.push(
      qs("ytmusic-player-page img"),
      qs("ytmusic-playlist-panel-video-renderer[selected] img"),
      qs("ytmusic-queue-item[selected] img"),
      qs("ytmusic-player-bar .thumbnail-image-wrapper img"),
      qs("ytmusic-player-bar img.image"),
      qs("ytmusic-player-bar .song-image img"),
      qs("ytmusic-player-bar img")
    );

    for (const img of candidates) {
      const url = pick(img);
      if (url) return url;
    }

    const msArt = readMediaSessionMeta().artUrl;
    if (msArt) return msArt;

    const video = getVideo();
    if (video?.poster) return upscaleArtUrl(video.poster);

    const vid = readVideoId();
    if (vid) return `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
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

  function findControlButton(barSelectors, fallbackSelectors) {
    const bar = qs("ytmusic-player-bar");
    if (bar) {
      // Preferir zonas de controles del player-bar (evita "Shuffle play" de colas/tarjetas).
      const regions = [
        ".middle-controls",
        ".left-controls",
        ".right-controls-buttons",
        ".right-controls",
        "#left-controls",
        "#right-controls",
      ];
      for (const region of regions) {
        const regionRoot =
          queryInTree(bar, [region]) ||
          (bar.shadowRoot && qs(region, bar.shadowRoot)) ||
          qs(region, bar);
        if (!regionRoot) continue;
        const hit = queryInTree(regionRoot, barSelectors);
        if (hit) return hit;
      }
      const hit = queryInTree(bar, barSelectors);
      if (hit) return hit;
    }
    return qs(fallbackSelectors);
  }

  function readRepeatFromBarHost() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return null;
    let mode =
      bar.getAttribute("repeat-mode") ||
      bar.getAttribute("repeatMode") ||
      null;
    try {
      if (!mode && bar.repeatMode != null) mode = String(bar.repeatMode);
      if (!mode && bar.__data?.repeatMode != null) mode = String(bar.__data.repeatMode);
    } catch (_) {
      /* noop */
    }
    if (!mode) return null;
    const m = String(mode).toUpperCase();
    if (m === "NONE") return "None";
    if (m === "ONE" || m === "TRACK") return "Track";
    if (m === "ALL" || m === "PLAYLIST") return "Playlist";
    return null;
  }

  function readShuffleFromBarHost() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return null;
    try {
      if (typeof bar.shuffleOn === "boolean") return bar.shuffleOn;
      if (typeof bar.shuffleEnabled === "boolean") return bar.shuffleEnabled;
      if (typeof bar.shuffle === "boolean") return bar.shuffle;
      if (typeof bar.shuffleMode === "boolean") return bar.shuffleMode;
      if (typeof bar.__data?.shuffleOn === "boolean") return bar.__data.shuffleOn;
      if (typeof bar.__data?.shuffle === "boolean") return bar.__data.shuffle;
      if (typeof bar.__data?.shuffleMode === "boolean") return bar.__data.shuffleMode;
    } catch (_) {
      /* noop */
    }
    for (const name of ["shuffle-mode", "shuffle", "shuffling", "is-shuffling"]) {
      if (!bar.hasAttribute(name)) continue;
      const v = (bar.getAttribute(name) || "").toLowerCase();
      if (v === "false" || v === "off" || v === "0") return false;
      return true;
    }
    // CSS themes: ytmusic-player-bar.shuffle / [shuffle]
    if (bar.classList.contains("shuffle") || bar.classList.contains("shuffling")) return true;
    return null;
  }

  function shuffleSelectors() {
    return [
      "tp-yt-paper-icon-button.shuffle",
      "paper-icon-button.shuffle",
      ".shuffle",
      "yt-button-shape.shuffle button",
      '[aria-label*="Shuffle"]',
      '[aria-label*="Aleatorio"]',
      '[aria-label*="shuffle"]',
      '[aria-label*="aleatorio"]',
    ];
  }

  function repeatSelectors() {
    return [
      "tp-yt-paper-icon-button.repeat",
      "paper-icon-button.repeat",
      ".repeat",
      "yt-button-shape.repeat button",
      '[aria-label*="Repeat"]',
      '[aria-label*="Repetir"]',
      '[aria-label*="repeat"]',
      '[aria-label*="repet"]',
    ];
  }

  function readLoopStatusFromButton(repeat) {
    if (!repeat) return null;
    const pressed = repeat.getAttribute("aria-pressed");
    const label = (
      repeat.getAttribute("aria-label") ||
      repeat.getAttribute("title") ||
      ""
    ).toLowerCase();

    if (
      /una canci|repeat one|\bone\b|track|1 canci/.test(label) ||
      repeat.classList.contains("repeat-one")
    ) {
      return "Track";
    }
    if (
      /todas|todo|repeat all|\ball\b|playlist|cola|album/.test(label) ||
      repeat.classList.contains("repeat-all") ||
      (pressed === "true" && !/off|desactiv|none|sin repet/.test(label))
    ) {
      return "Playlist";
    }
    if (/off|none|sin repet|no repet|desactivad/.test(label) && !/una|todas|all|one/.test(label)) {
      return "None";
    }
    if (pressed === "true") return "Playlist";
    if (pressed === "false") return "None";
    return null;
  }

  function readLoopStatus() {
    const ov = window.__YTM_DECK_LOOP_OVERRIDE__;
    if (ov && performance.now() < ov.until) {
      const live =
        readRepeatFromBarHost() ||
        readLoopStatusFromButton(
          findControlButton(
            repeatSelectors(),
            'ytmusic-player-bar .repeat, ytmusic-player-bar tp-yt-paper-icon-button.repeat, ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]'
          )
        );
      // Solo soltar override cuando el DOM confirma el valor pedído.
      if (live === ov.value) {
        window.__YTM_DECK_LOOP_OVERRIDE__ = null;
        return live;
      }
      return ov.value;
    }
    const fromHost = readRepeatFromBarHost();
    if (fromHost) return fromHost;
    return readLoopStatusFromButton(
      findControlButton(
        repeatSelectors(),
        'ytmusic-player-bar .repeat, ytmusic-player-bar tp-yt-paper-icon-button.repeat, ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]'
      )
    );
  }

  function readShuffleFromButton(shuffle) {
    if (!shuffle) return null;
    const pressed = shuffle.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;

    const label = (
      shuffle.getAttribute("aria-label") ||
      shuffle.getAttribute("title") ||
      ""
    ).toLowerCase();

    // Tooltips de acción: "Desactivar aleatorio" = ahora ESTÁ activo.
    if (/desactivar|turn off|disable shuffle|apag/.test(label)) return true;
    if (/(?:^|[^a-záéíóú])activar(?!do)|turn on|enable shuffle|encend/.test(label)) {
      return false;
    }
    if (/activado|enabled|\bon\b|aleatorio on/.test(label)) return true;
    if (/desactivad|disabled|\boff\b|aleatorio off/.test(label)) return false;

    if (
      shuffle.classList.contains("style-default-active") ||
      (shuffle.hasAttribute("aria-checked") && shuffle.getAttribute("aria-checked") === "true")
    ) {
      return true;
    }
    return null;
  }

  function readShuffle() {
    const ov = window.__YTM_DECK_SHUFFLE_OVERRIDE__;
    if (ov && performance.now() < ov.until) {
      const liveHost = readShuffleFromBarHost();
      const liveBtn = readShuffleFromButton(
        findControlButton(
          shuffleSelectors(),
          'ytmusic-player-bar .shuffle, ytmusic-player-bar tp-yt-paper-icon-button.shuffle, ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]'
        )
      );
      const live = liveHost != null ? liveHost : liveBtn;
      if (live === ov.value) {
        window.__YTM_DECK_SHUFFLE_OVERRIDE__ = null;
        return live;
      }
      return ov.value;
    }
    const fromHost = readShuffleFromBarHost();
    if (fromHost != null) return fromHost;
    return readShuffleFromButton(
      findControlButton(
        shuffleSelectors(),
        'ytmusic-player-bar .shuffle, ytmusic-player-bar tp-yt-paper-icon-button.shuffle, ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]'
      )
    );
  }

  function synthClick(el) {
    // Fallback genérico (cola, etc.). Para shuffle/repeat preferir tapPlayerMode.
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function tapPlayerMode(kind) {
    // Handlers Polymer en ytmusic-player-bar: un solo avance por llamada.
    // el.click() en YT-ICON-BUTTON dispara listeners internos + bubbling y
    // avanza repeat 2 veces (NONE→ALL→ONE) y re-mezcla la cola varias veces.
    const bar = qs("ytmusic-player-bar");
    if (bar) {
      try {
        if (kind === "repeat" && typeof bar.onRepeatButtonClick === "function") {
          bar.onRepeatButtonClick();
          return true;
        }
        if (kind === "shuffle" && typeof bar.onShuffleButtonClick === "function") {
          bar.onShuffleButtonClick();
          return true;
        }
      } catch (_) {
        /* caer al botón DOM */
      }
    }
    const btn =
      kind === "repeat"
        ? findControlButton(
            repeatSelectors(),
            'ytmusic-player-bar .repeat, ytmusic-player-bar tp-yt-paper-icon-button.repeat, ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]'
          )
        : findControlButton(
            shuffleSelectors(),
            'ytmusic-player-bar .shuffle, ytmusic-player-bar tp-yt-paper-icon-button.shuffle, ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]'
          );
    return synthClick(btn);
  }

  function clickRepeat(times) {
    const n = Math.max(1, Math.min(5, Number(times) || 1));
    let i = 0;
    const step = () => {
      if (i >= n) {
        scheduleStateReports();
        return;
      }
      i += 1;
      window.__YTM_DECK_IGNORE_MODE_CLICK__ = performance.now() + 800;
      tapPlayerMode("repeat");
      setTimeout(step, 400);
    };
    step();
    return true;
  }

  function ensureRepeat(desiredStatus) {
    // desiredStatus: "None" | "Playlist" | "Track"
    // Un solo tap: el API ya calculó el siguiente modo (iteration=1).
    const order = ["None", "Playlist", "Track"];
    if (!order.includes(desiredStatus)) {
      return clickRepeat(1);
    }

    window.__YTM_DECK_LOOP_OVERRIDE__ = {
      value: desiredStatus,
      until: performance.now() + 3500,
    };
    const live =
      readRepeatFromBarHost() ||
      readLoopStatusFromButton(
        findControlButton(
          repeatSelectors(),
          'ytmusic-player-bar .repeat, ytmusic-player-bar tp-yt-paper-icon-button.repeat, ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]'
        )
      ) ||
      "None";
    if (live === desiredStatus) {
      reportState();
      return true;
    }
    window.__YTM_DECK_IGNORE_MODE_CLICK__ = performance.now() + 800;
    if (!tapPlayerMode("repeat")) return false;
    setTimeout(() => reportState(), 350);
    setTimeout(() => reportState(), 900);
    return true;
  }

  function ensureShuffle(desired) {
    // Un solo tap via onShuffleButtonClick (evita saltos de cola).
    const current = readShuffle();
    if (typeof desired === "boolean") {
      if (current === desired) {
        window.__YTM_DECK_SHUFFLE_OVERRIDE__ = {
          value: desired,
          until: performance.now() + 2500,
        };
        reportState();
        return true;
      }
      window.__YTM_DECK_SHUFFLE_OVERRIDE__ = {
        value: desired,
        until: performance.now() + 3500,
      };
      window.__YTM_DECK_IGNORE_MODE_CLICK__ = performance.now() + 800;
      if (!tapPlayerMode("shuffle")) return false;
      setTimeout(() => {
        reportState();
        setTimeout(() => {
          primeQueueForApi();
          reportState();
        }, 900);
      }, 500);
      return true;
    }
    const flipped = current == null ? true : !current;
    window.__YTM_DECK_SHUFFLE_OVERRIDE__ = {
      value: flipped,
      until: performance.now() + 3500,
    };
    window.__YTM_DECK_IGNORE_MODE_CLICK__ = performance.now() + 800;
    const ok = tapPlayerMode("shuffle");
    setTimeout(() => {
      primeQueueForApi();
      reportState();
    }, 900);
    return ok;
  }

  function clickShuffle() {
    return ensureShuffle(undefined);
  }

  function bindPlayerModeObservers() {
    if (window.__YTM_DECK_MODE_OBS__) return;
    window.__YTM_DECK_MODE_OBS__ = true;

    const ping = () => {
      try {
        reportState();
      } catch (_) {
        /* noop */
      }
    };

    const attachBar = () => {
      const bar = qs("ytmusic-player-bar");
      if (!bar || bar.__ytmDeckModeObs) return;
      bar.__ytmDeckModeObs = true;
      new MutationObserver(() => {
        setTimeout(ping, 50);
      }).observe(bar, {
        attributes: true,
        attributeFilter: [
          "repeat-mode",
          "shuffle",
          "shuffle-mode",
          "shuffling",
          "class",
        ],
      });
    };

    attachBar();
    setInterval(attachBar, 2000);

    // Toque manual en el reproductor → override + report para Decky.
    document.addEventListener(
      "click",
      (event) => {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        const nodes = path.length ? path : [event.target];
        let kind = null;
        for (const node of nodes) {
          if (!node || typeof node.getAttribute !== "function") continue;
          const label = (
            node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            (typeof node.className === "string" ? node.className : "") ||
            ""
          ).toString();
          if (/shuffle|aleatorio/i.test(label) || (node.classList && node.classList.contains("shuffle"))) {
            kind = "shuffle";
            break;
          }
          if (/repeat|repetir/i.test(label) || (node.classList && node.classList.contains("repeat"))) {
            kind = "repeat";
            break;
          }
        }
        if (!kind) return;
        // Ignorar clics sintéticos desde ensureShuffle/ensureRepeat.
        if (performance.now() < (window.__YTM_DECK_IGNORE_MODE_CLICK__ || 0)) return;

        if (kind === "shuffle") {
          // Leer DOM real, no el override del API (si no, !before invierte mal).
          const saved = window.__YTM_DECK_SHUFFLE_OVERRIDE__;
          window.__YTM_DECK_SHUFFLE_OVERRIDE__ = null;
          const before =
            readShuffleFromBarHost() ??
            readShuffleFromButton(
              findControlButton(
                shuffleSelectors(),
                'ytmusic-player-bar .shuffle, ytmusic-player-bar tp-yt-paper-icon-button.shuffle, ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]'
              )
            );
          if (saved && performance.now() < saved.until && before == null) {
            window.__YTM_DECK_SHUFFLE_OVERRIDE__ = saved;
          }
          const guess = before == null ? null : !before;
          if (guess != null) {
            window.__YTM_DECK_SHUFFLE_OVERRIDE__ = {
              value: guess,
              until: performance.now() + 4000,
            };
          } else {
            setTimeout(() => {
              const after =
                readShuffleFromBarHost() ??
                readShuffleFromButton(
                  findControlButton(
                    shuffleSelectors(),
                    'ytmusic-player-bar .shuffle, ytmusic-player-bar tp-yt-paper-icon-button.shuffle, ytmusic-player-bar [aria-label*="Shuffle"], ytmusic-player-bar [aria-label*="Aleatorio"]'
                  )
                );
              if (after != null) {
                window.__YTM_DECK_SHUFFLE_OVERRIDE__ = {
                  value: after,
                  until: performance.now() + 4000,
                };
              }
              ping();
            }, 100);
          }
        } else {
          // Tras el click nativo, leer en microtask el modo nuevo.
          setTimeout(() => {
            const saved = window.__YTM_DECK_LOOP_OVERRIDE__;
            window.__YTM_DECK_LOOP_OVERRIDE__ = null;
            const after =
              readRepeatFromBarHost() ||
              readLoopStatusFromButton(
                findControlButton(
                  repeatSelectors(),
                  'ytmusic-player-bar .repeat, ytmusic-player-bar tp-yt-paper-icon-button.repeat, ytmusic-player-bar [aria-label*="Repeat"], ytmusic-player-bar [aria-label*="Repetir"]'
                )
              );
            if (after) {
              window.__YTM_DECK_LOOP_OVERRIDE__ = {
                value: after,
                until: performance.now() + 4000,
              };
            } else if (saved && performance.now() < saved.until) {
              window.__YTM_DECK_LOOP_OVERRIDE__ = saved;
            }
            ping();
          }, 80);
        }
        setTimeout(ping, 120);
        setTimeout(ping, 450);
        setTimeout(ping, 1000);
      },
      true
    );
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

  function shouldRelocatePlayerBarThumb(thumb, bar) {
    if (!thumb || !bar?.contains(thumb)) return false;
    if (thumb.closest(".deck-media-thumb, #side-panel, ytmusic-queue-item, ytmusic-playlist-panel-video-renderer")) {
      return false;
    }
    return !!thumb.closest("ytmusic-player-bar");
  }

  function ensureDeckMediaThumbContent(bar, thumbWrap) {
    if (!bar || !thumbWrap) return;

    const hasNativeThumb = qs(
      ".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer, yt-img-shadow.image, yt-img-shadow#thumbnail",
      thumbWrap
    );
    if (hasNativeThumb) return;

    const artUrl = readArtUrl();
    if (!artUrl) return;

    let img = qs("img.deck-media-thumb-fallback", thumbWrap);
    if (!img) {
      img = document.createElement("img");
      img.className = "deck-media-thumb-fallback image";
      img.alt = "";
      thumbWrap.appendChild(img);
    }
    if (img.src !== artUrl) img.src = artUrl;
  }

  function syncPlayerBarThumbnail() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return;

    ensureDeckMediaInfo(bar);
    const thumbWrap = qs(".deck-media-thumb", bar);
    ensureDeckMediaThumbContent(bar, thumbWrap);

    const active = isMediaActive();
    const thumbSelectors =
      ".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer, yt-img-shadow.image, yt-img-shadow#thumbnail";

    qsa(thumbSelectors, bar).forEach((el) => {
      const img = qs("img", el);
      const inDeckThumb = !!el.closest(".deck-media-thumb");
      const show = active && inDeckThumb && isValidArtImg(img);
      setPlayerBarThumbVisible(el, show);
    });

    if (thumbWrap) {
      const img = qs("img", thumbWrap);
      const showWrap = active && isValidArtImg(img);
      if (showWrap) {
        thumbWrap.style.removeProperty("display");
        thumbWrap.style.removeProperty("visibility");
        thumbWrap.style.removeProperty("width");
        thumbWrap.style.removeProperty("height");
        thumbWrap.style.removeProperty("min-width");
        thumbWrap.style.removeProperty("min-height");
        thumbWrap.style.removeProperty("max-width");
        thumbWrap.style.removeProperty("max-height");
        thumbWrap.style.removeProperty("flex");
        thumbWrap.style.removeProperty("overflow");
        thumbWrap.style.removeProperty("pointer-events");
      }
    }

    qsa("img.image, img#img", bar).forEach((img) => {
      if (!img.closest(".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer, yt-img-shadow")) {
        const inDeckThumb = !!img.closest(".deck-media-thumb");
        setPlayerBarThumbVisible(img, active && inDeckThumb && isValidArtImg(img));
      }
    });
  }

  function syncMediaActiveUi() {
    const active = isMediaActive();
    document.documentElement.classList.toggle("ytm-deck-media-active", active);
    syncPlayerBarThumbnail();
    return active;
  }

  function isPlaceholderThumbUrl(url) {
    if (!url || typeof url !== "string") return true;
    if (url.startsWith("data:")) return true;
    if (url.includes("placeholder")) return true;
    return false;
  }

  function pickImageUrl(img) {
    if (!img) return "";
    const candidates = [
      img.currentSrc,
      img.src,
      img.getAttribute?.("data-src"),
      img.getAttribute?.("data-thumb"),
      img.getAttribute?.("data-url"),
    ];
    for (const raw of candidates) {
      const url = (raw || "").trim();
      if (!url || isPlaceholderThumbUrl(url)) continue;
      if (url.startsWith("data:")) continue;
      return url;
    }
    return "";
  }

  function extractVideoIdFromText(text) {
    if (!text) return "";
    const m =
      String(text).match(/[?&]v=([\w-]{11})/) ||
      String(text).match(/youtu\.be\/([\w-]{11})/) ||
      String(text).match(/\/(?:watch|shorts|embed)\/([\w-]{11})/) ||
      String(text).match(/\/vi\/([\w-]{11})\//) ||
      String(text).match(/"videoId"\s*:\s*"([\w-]{11})"/);
    return m ? m[1] : "";
  }

  function readDomProp(el, ...names) {
    if (!el) return undefined;
    for (const name of names) {
      try {
        if (el[name] != null && el[name] !== "") return el[name];
      } catch (_) {}
      try {
        if (el.__data && el.__data[name] != null && el.__data[name] !== "") {
          return el.__data[name];
        }
      } catch (_) {}
      try {
        if (el.data && el.data[name] != null && el.data[name] !== "") {
          return el.data[name];
        }
      } catch (_) {}
    }
    return undefined;
  }

  function videoIdFromUnknown(value) {
    if (!value) return "";
    if (typeof value === "string") {
      if (/^[\w-]{11}$/.test(value)) return value;
      return extractVideoIdFromText(value);
    }
    if (typeof value === "object") {
      const direct = value.videoId || value.video_id || value.id;
      if (typeof direct === "string" && /^[\w-]{11}$/.test(direct)) return direct;
      try {
        return extractVideoIdFromText(JSON.stringify(value).slice(0, 4000));
      } catch (_) {
        return "";
      }
    }
    return "";
  }

  function thumbFromUnknown(value) {
    if (!value) return "";
    if (typeof value === "string" && !isPlaceholderThumbUrl(value)) return value;
    if (typeof value !== "object") return "";
    const list =
      value.thumbnails ||
      value.sources ||
      (Array.isArray(value) ? value : null) ||
      value.thumbnail?.thumbnails;
    if (Array.isArray(list)) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const u = list[i]?.url || list[i]?.src || "";
        if (u && !isPlaceholderThumbUrl(u)) return u;
      }
    }
    const nested = value.url || value.src;
    if (typeof nested === "string" && !isPlaceholderThumbUrl(nested)) return nested;
    return "";
  }

  function readVideoId() {
    try {
      const player =
        document.getElementById("movie_player") ||
        qs(".html5-video-player") ||
        qs("ytmusic-player");
      const data = player?.getVideoData?.();
      const id = data?.video_id || data?.videoId;
      if (id && /^[\w-]{11}$/.test(id)) return id;
    } catch (_) {}

    const video = getVideo();
    const fromSrc = extractVideoIdFromText(video?.currentSrc || video?.src || "");
    if (fromSrc) return fromSrc;

    const attrHosts = [
      qs("ytmusic-player-bar"),
      qs("ytmusic-player-page"),
      qs("ytmusic-app-layout"),
      qs("ytmusic-player"),
    ];
    for (const el of attrHosts) {
      if (!el) continue;
      const fromProp = videoIdFromUnknown(
        readDomProp(el, "videoId", "video_id", "currentVideoId")
      );
      if (fromProp) return fromProp;
      for (const name of ["video-id", "videoId", "data-video-id"]) {
        const v = el.getAttribute?.(name);
        if (v && /^[\w-]{11}$/.test(v)) return v;
      }
    }

    const link = qs(
      "ytmusic-player-bar a[href*='watch?v='], ytmusic-player-bar a[href*='youtu.be/'], ytmusic-player-bar a[href*='/watch/'], ytmusic-player-page a[href*='watch?v=']"
    );
    const fromLink = extractVideoIdFromText(link?.href || "");
    if (fromLink) return fromLink;

    try {
      const fromLoc = extractVideoIdFromText(location.href);
      if (fromLoc) return fromLoc;
      const fromHash = extractVideoIdFromText(location.hash || "");
      if (fromHash) return fromHash;
    } catch (_) {}

    for (const item of queueElements()) {
      const selected =
        item.hasAttribute("selected") ||
        item.classList.contains("playing") ||
        item.getAttribute("aria-selected") === "true";
      if (!selected) continue;
      const id =
        videoIdFromUnknown(readDomProp(item, "videoId", "video_id")) ||
        item.getAttribute("video-id") ||
        extractVideoIdFromText(qs("a[href*='v=']", item)?.href || "") ||
        extractVideoIdFromText(item.outerHTML?.slice?.(0, 4000) || "");
      if (id) return id;
    }

    return "";
  }

  function queueElements() {
    const selectors = [
      "#side-panel ytmusic-player-queue-item",
      "#side-panel ytmusic-queue-item",
      "#side-panel ytmusic-playlist-panel-video-renderer",
      "ytmusic-player-page ytmusic-player-queue-item",
      "ytmusic-player-page ytmusic-queue-item",
      "ytmusic-player-page ytmusic-playlist-panel-video-renderer",
      "ytmusic-tabbed-queue ytmusic-player-queue-item",
      "ytmusic-tabbed-queue ytmusic-queue-item",
      "ytmusic-tabbed-queue ytmusic-playlist-panel-video-renderer",
      "ytmusic-player-queue-item",
      "ytmusic-queue-item",
      "ytmusic-playlist-panel-video-renderer",
    ];
    const seen = new Set();
    const items = [];
    for (const sel of selectors) {
      for (const el of qsa(sel)) {
        if (!seen.has(el)) {
          seen.add(el);
          items.push(el);
        }
      }
    }
    return items;
  }

  function readQueueItemData(item) {
    const roots = [];
    if (item?.shadowRoot) roots.push(item.shadowRoot);
    if (item) roots.push(item);

    let title = "";
    let artist = "";
    let thumbUrl = thumbFromUnknown(
      readDomProp(item, "thumbnail", "thumbnails", "thumbnailData")
    );
    let link = null;
    let videoId =
      videoIdFromUnknown(readDomProp(item, "videoId", "video_id")) ||
      item.getAttribute?.("video-id") ||
      "";
    for (const root of roots) {
      if (!title) {
        title =
          readText(".song-title, #title, .title", root) ||
          readText(".song-title a, #title a", root) ||
          "";
      }
      if (!artist) artist = readText(".byline, .subtitle, yt-formatted-string.byline", root) || "";
      if (!thumbUrl) {
        for (const img of qsa("img", root)) {
          const url = pickImageUrl(img);
          if (url) {
            thumbUrl = url;
            break;
          }
        }
      }
      if (!thumbUrl) {
        const shadowHost = qs("yt-img-shadow#thumbnail, yt-img-shadow.thumbnail, #thumbnail", root);
        thumbUrl =
          pickImageUrl(qs("img", shadowHost || root)) ||
          thumbFromUnknown(readDomProp(shadowHost, "thumbnail", "thumbnails", "imageSrc"));
      }
      if (!link) link = qs("a[href*='v='], a[href*='youtu.be/'], a.yt-simple-endpoint", root);
      if (!videoId) {
        videoId =
          qs("[video-id]", root)?.getAttribute("video-id") ||
          extractVideoIdFromText(link?.href || "") ||
          videoId;
      }
    }

    if (!videoId && link?.href) {
      videoId = extractVideoIdFromText(link.href);
    }
    if (!thumbUrl && videoId) {
      thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }

    const selected =
      item.hasAttribute("selected") ||
      item.classList.contains("playing") ||
      item.getAttribute("aria-selected") === "true";
    const duration = readText(".duration, .badge-style-type, .length", item) || "";

    // Si es la pista actual y el DOM aún no hidrató thumb, usa carátula del player.
    if (selected && !thumbUrl) {
      thumbUrl = readArtUrl() || "";
    }
    if (selected && !videoId) {
      // Evitar recursión infinita: preferir fuentes locales.
      try {
        const player =
          document.getElementById("movie_player") || qs(".html5-video-player");
        const id = player?.getVideoData?.()?.video_id;
        if (id && /^[\w-]{11}$/.test(id)) videoId = id;
      } catch (_) {}
    }

    return {
      playlistPanelVideoRenderer: {
        title: { runs: [{ text: title }] },
        shortBylineText: { runs: [{ text: artist }] },
        thumbnail: { thumbnails: thumbUrl ? [{ url: thumbUrl }] : [] },
        videoId: videoId || "",
        selected,
        lengthText: duration ? { runs: [{ text: duration }] } : undefined,
      },
    };
  }

  function buildCurrentTrackQueueItem() {
    const title = readSongTitle();
    if (!title) return null;
    const art = readArtUrl();
    return {
      playlistPanelVideoRenderer: {
        title: { runs: [{ text: title }] },
        shortBylineText: { runs: [{ text: readSongArtist() }] },
        thumbnail: { thumbnails: art ? [{ url: art }] : [] },
        videoId: readVideoId(),
        selected: true,
      },
    };
  }

  function collectQueue() {
    const items = queueElements()
      .map(readQueueItemData)
      .filter((item) => item.playlistPanelVideoRenderer?.title?.runs?.[0]?.text);
    if (items.length > 0) return { items };
    const current = buildCurrentTrackQueueItem();
    return { items: current ? [current] : [] };
  }

  function primeQueueForApi() {
    if (queueElements().length > 0) {
      reportState();
      return;
    }
    if (!readSongTitle()) return;

    // No reabrir la vista de reproducción si el usuario acaba de minimizar con B.
    if (
      !isPlayerPageOpen() &&
      performance.now() >= (window.__YTM_DECK_PLAYER_CLOSED_UNTIL__ || 0)
    ) {
      openPlayerPage();
    }
    ensureQueueTab();
    ensureQueueItemMenus();
    [400, 900, 1600].forEach((ms) => {
      setTimeout(() => reportState(), ms);
    });
  }

  function queueJumpToIndex(index) {
    const items = queueElements();
    const item = items[index];
    if (!item) return false;
    return playQueueItem(item);
  }

  function queueRemoveAt(index) {
    const items = queueElements();
    const item = items[index];
    if (!item) return false;
    let removed = false;
    forEachShadowRoot(item, (root) => {
      if (removed) return;
      const menuBtn =
        qs("ytmusic-menu-renderer button, ytmusic-menu-renderer tp-yt-paper-icon-button", root) ||
        qs("yt-icon-button[aria-label*='Menu'], yt-icon-button[aria-label*='Menú']", root);
      if (!menuBtn) return;
      menuBtn.click();
      const popup = qs(
        "tp-yt-iron-dropdown[opened], ytmusic-menu-popup-renderer, ytmusic-menu-renderer #menu"
      );
      const removeBtn = popup
        ? qsa("tp-yt-paper-item, yt-formatted-string", popup).find((el) => {
            const text = (el.textContent || "").toLowerCase();
            return /remove from queue|quitar de la cola|eliminar de la cola/.test(text);
          })
        : null;
      if (removeBtn) {
        removeBtn.click();
        removed = true;
      }
    });
    return removed;
  }

  function queueClearAll() {
    const items = queueElements();
    for (let i = items.length - 1; i >= 0; i--) {
      if (!queueRemoveAt(i)) return false;
    }
    return true;
  }

  function collectState() {
    const video = getVideo();
    const duration = video ? video.duration || 0 : 0;
    const current = video ? video.currentTime || 0 : 0;
    const paused = video ? video.paused : true;
    const ms = readMediaSessionMeta();
    const title =
      readSongTitle() ||
      readText(".deck-now-playing-meta .deck-title") ||
      ms.title ||
      "";
    const artist =
      readSongArtist() ||
      readText(".deck-now-playing-meta .deck-artist") ||
      ms.artist ||
      "";
    const artUrl = readArtUrl() || ms.artUrl || "";

    let playbackStatus = "Stopped";
    if (video && Number.isFinite(duration) && duration > 0) {
      playbackStatus = paused ? "Paused" : "Playing";
    } else if (title) {
      // MediaSession / título presentes: si no hay <video> usable, asumimos playing
      // salvo que mediaSession diga lo contrario.
      const msState = navigator.mediaSession?.playbackState;
      if (msState === "paused") playbackStatus = "Paused";
      else if (msState === "playing" || !paused) playbackStatus = "Playing";
      else playbackStatus = paused ? "Paused" : "Playing";
    }

    return {
      title,
      artist,
      album: ms.album || "",
      artUrl,
      trackId: (title + artist).replace(/\s+/g, "_").slice(0, 80),
      videoId: readVideoId(),
      lengthUs: Math.round(duration * 1_000_000),
      positionUs: Math.round(current * 1_000_000),
      playbackStatus,
      volume: video ? video.volume : 1,
      muted: video ? !!video.muted : false,
      canPlay: !!video || !!title,
      canPause: !!video || !!title,
      canGoNext: !!qs('ytmusic-player-bar .next-button, ytmusic-player-bar [aria-label*="Next"], ytmusic-player-bar [aria-label*="Siguiente"]'),
      canGoPrevious: !!qs('ytmusic-player-bar .previous-button, ytmusic-player-bar [aria-label*="Previous"], ytmusic-player-bar [aria-label*="Anterior"]'),
      canSeek: !!video && duration > 0,
      shuffle: readShuffle(),
      loopStatus: readLoopStatus(),
      queue: collectQueue().items,
    };
  }

  function reportState() {
    if (!window.bridge || !window.bridge.reportState) {
      // Canal Qt aún no listo: reintentar en breve.
      if (!window.__YTM_DECK_REPORT_RETRY__) {
        window.__YTM_DECK_REPORT_RETRY__ = setTimeout(() => {
          window.__YTM_DECK_REPORT_RETRY__ = null;
          reportState();
        }, 400);
      }
      return;
    }
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

  function deckCssNum(name, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
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
      return Math.min(1.75, forced);
    }

    if (scale < 1.0) scale = 1.0;
    return Math.min(1.75, scale);
  }

  function resolveDeckScale(w, h, wide) {
    const forced = parseFloat(window.__YTM_DECK_UI_SCALE__);
    if (wide) {
      if (Number.isFinite(forced) && forced > 0) return Math.min(1.75, forced);
      return WIDE_FIXED_SCALE;
    }
    return computeDeckScale(w, h);
  }

  function applyViewportMetrics() {
    const { w, h } = resolveViewportSize();
    const aspect = w / Math.max(h, 1);
    const wide = aspect >= WIDE_ASPECT;
    const scale = resolveDeckScale(w, h, wide);
    const root = document.documentElement;
    const navBase = wide ? 360 : 336;

    root.style.setProperty("--deck-ui-scale", scale.toFixed(3));
    root.style.setProperty("--deck-nav-w", wide ? `${navBase}px` : deckPx(navBase, scale));
    root.style.setProperty("--deck-player-h", deckPx(wide ? 104 : 112, scale));
    root.style.setProperty("--deck-touch-xl", deckPx(wide ? 68 : 72, scale));
    root.style.setProperty("--deck-touch", deckPx(wide ? 52 : 56, scale));
    root.style.setProperty("--deck-player-thumb", wide ? "62px" : deckPx(62, scale));
    root.style.setProperty("--deck-gap", deckPx(10, scale));
    root.style.setProperty("--deck-col-gap", deckPx(6, scale));
    root.style.setProperty("--deck-content-pad", deckPx(12, scale));
    root.style.setProperty("--deck-volume-slider-w", wide ? "140px" : deckPx(152, scale));
    root.style.setProperty(
      "--deck-media-text-max",
      wide
        ? "clamp(100px, 26vw, 280px)"
        : `clamp(${deckPx(120, scale)}, 32vw, ${deckPx(360, scale)})`
    );
    root.style.setProperty(
      "--deck-media-text-min",
      `clamp(${deckPx(140, scale)}, 34vw, ${deckPx(380, scale)})`
    );
    root.style.setProperty("--deck-fs-nav", deckPx(18, scale));
    root.style.setProperty("--deck-fs-chip", deckPx(16, scale));
    root.style.setProperty("--deck-fs-body", deckPx(15, scale));
    root.style.setProperty("--deck-fs-item-title", deckPx(17, scale));
    root.style.setProperty("--deck-fs-section", deckPx(24, scale));
    root.style.setProperty("--deck-fs-player-title", deckPx(17, scale));
    root.style.setProperty("--deck-fs-player-artist", deckPx(15, scale));
    root.style.setProperty("--deck-fs-queue-title", deckPx(20, scale));
    root.style.setProperty("--deck-fs-queue-meta", deckPx(17, scale));
    root.style.setProperty("--deck-fs-queue-tab", deckPx(17, scale));
    root.style.setProperty("--deck-fs-queue-header-title", deckPx(15, scale));
    root.style.setProperty("--deck-fs-queue-header-subtitle", deckPx(18, scale));
    root.style.setProperty("--deck-queue-thumb", deckPx(56, scale));
    root.style.setProperty("--deck-queue-item-min-h", deckPx(72, scale));
    root.style.setProperty("--deck-queue-item-pad-y", deckPx(10, scale));
    root.style.setProperty("--deck-queue-item-pad-x", deckPx(10, scale));
    root.style.setProperty("--deck-queue-item-gap", "0px");
    root.style.setProperty("--deck-queue-item-radius", deckPx(14, scale));
    root.style.setProperty("--deck-queue-menu-size", deckPx(46, scale));
    root.style.setProperty("--deck-queue-menu-icon", deckPx(26, scale));
    root.style.setProperty("--deck-queue-duration-min", deckPx(44, scale));
    root.style.setProperty("--deck-queue-actions-min", deckPx(108, scale));
    root.style.setProperty("--deck-queue-panel-pad-y", deckPx(14, scale));
    root.style.setProperty("--deck-queue-panel-pad-x", deckPx(16, scale));
    root.style.setProperty("--deck-queue-tab-min-h", deckPx(52, scale));
    root.style.setProperty("--deck-queue-header-min-h", deckPx(56, scale));
    root.style.setProperty("--deck-avatar-size", deckPx(48, scale));
    root.style.setProperty("--deck-player-progress-knob", deckPx(26, scale));
    root.style.setProperty("--deck-volume-knob", deckPx(24, scale));
    root.style.setProperty("--deck-volume-slider-h", deckPx(40, scale));
    root.style.setProperty("--deck-player-progress-inset-left", deckPx(42, scale));
    root.style.setProperty("--deck-player-progress-inset-right", deckPx(42, scale));
    root.classList.toggle("ytm-deck-wide", wide);
    root.classList.toggle("ytm-deck-large-ui", scale >= 1.28);
    const touchUi =
      !!window.__YTM_DECK_TOUCH__ ||
      !!window.__YTM_DECK_STEAM__ ||
      wide ||
      window.matchMedia("(pointer: coarse)").matches ||
      (navigator.maxTouchPoints || 0) > 0;
    root.classList.toggle("ytm-deck-touch", touchUi);
    root.classList.toggle("ytm-deck-steam", !!window.__YTM_DECK_STEAM__ || !!window.__YTM_DECK_TOUCH__);
    if (touchUi) {
      root.style.cursor = "none";
      document.body && (document.body.style.cursor = "none");
    }

    const drawer = qs("tp-yt-app-drawer#guide");
    if (drawer) {
      drawer.style.setProperty("--paper-drawer-width", wide ? `${navBase}px` : deckPx(navBase, scale));
    }
  }

  function setPlayingMode(playing) {
    const changed = playing !== lastPlaying;
    lastPlaying = !!playing;
    // Siempre forzar la clase: si quedó desincronizada, toggle solo-on-change no la limpia.
    document.documentElement.classList.toggle("ytm-deck-playing", !!playing);
    if (changed) {
      syncAccountBarPlacement();
    }
  }

  function getAccountBar() {
    return (
      qs("ytmusic-nav-bar #button-bar") ||
      qs("#button-bar") ||
      qs("ytmusic-nav-bar #right-content") ||
      qs("#right-content")
    );
  }

  function syncAccountBarPlacement() {
    const accountBar = getAccountBar();
    const navBar = qs("ytmusic-nav-bar");
    if (!accountBar || !navBar) return;

    const playing = document.documentElement.classList.contains("ytm-deck-playing");
    const guideSlot = qs("#guide-content > .deck-guide-account-bar");

    if (playing) {
      if (accountBar.parentElement !== navBar) navBar.appendChild(accountBar);
      return;
    }

    if (guideSlot && accountBar.parentElement !== guideSlot) {
      guideSlot.appendChild(accountBar);
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
    if (titleEl) titleEl.textContent = barTitle || "";
    if (artistEl) artistEl.textContent = barArtist || "";
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
    const accountBar = getAccountBar();
    if (!accountBar) return;
    accountBar.style.display = "flex";
    accountBar.style.visibility = "visible";
    accountBar.style.pointerEvents = "auto";
    accountBar.style.touchAction = "manipulation";
    accountBar.style.zIndex = "80";
    mountGuideAccountBar(accountBar);
    syncAccountBarPlacement();
    syncGuideAccountBarLayout();
    ensureGuideScrollLayout();
  }

  function mountGuideAccountBar(accountBar) {
    const guideContent = qs("tp-yt-app-drawer#guide #guide-content");
    if (!guideContent || !accountBar) return;

    const spacer = qs("#guide-spacer");
    if (spacer) {
      spacer.style.display = "none";
      spacer.style.height = "0";
      spacer.style.marginTop = "0";
      spacer.style.marginBottom = "0";
      spacer.style.padding = "0";
    }

    const contentContainer = qs("tp-yt-app-drawer#guide #contentContainer");
    if (contentContainer) {
      contentContainer.style.padding = "0";
      contentContainer.style.paddingTop = "0";
      contentContainer.style.top = "0";
      contentContainer.style.position = "relative";
      contentContainer.style.height = "100%";
      contentContainer.style.overflowX = "hidden";
      contentContainer.style.overflowY = "scroll";
      contentContainer.style.webkitOverflowScrolling = "touch";
    }

    const staleTopBar = qs(".deck-guide-top-bar", guideContent);
    if (staleTopBar) staleTopBar.remove();

    let slot = qs("#guide-content > .deck-guide-account-bar");
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "deck-guide-account-bar";
      guideContent.insertBefore(slot, guideContent.firstChild);
    }

    let brand = qs(".deck-guide-brand", slot);
    if (!brand) {
      brand = document.createElement("div");
      brand.className = "deck-guide-brand";
      slot.insertBefore(brand, slot.firstChild);
    }

    const logo =
      qs("ytmusic-logo-renderer, #logo, ytmusic-logo", brand) ||
      qs("ytmusic-nav-bar .center-content ytmusic-logo-renderer") ||
      qs("ytmusic-nav-bar ytmusic-logo-renderer") ||
      qs("ytmusic-nav-bar #logo") ||
      qs("ytmusic-nav-bar ytmusic-logo");
    if (logo && logo.parentElement !== brand) {
      brand.appendChild(logo);
    }

    qsa("ytmusic-cast-button", slot).forEach((castBtn) => {
      castBtn.style.display = "none";
      castBtn.style.visibility = "hidden";
      castBtn.style.pointerEvents = "none";
    });

    if (
      !document.documentElement.classList.contains("ytm-deck-playing") &&
      accountBar.parentElement !== slot
    ) {
      slot.appendChild(accountBar);
    }

    const inGuideSlot = accountBar.parentElement === slot;
    if (inGuideSlot) {
      accountBar.style.position = "";
      accountBar.style.top = "";
      accountBar.style.right = "";
      accountBar.style.left = "";
      accountBar.style.height = "";
      accountBar.style.minHeight = "";
      accountBar.style.transform = "";
      accountBar.style.flex = "";
      accountBar.style.alignItems = "center";
      accountBar.style.justifyContent = "flex-end";
      accountBar.style.gap = "10px";
    } else {
      accountBar.style.position = "relative";
      accountBar.style.top = "auto";
      accountBar.style.right = "auto";
      accountBar.style.left = "auto";
      accountBar.style.height = "auto";
      accountBar.style.minHeight = "48px";
      accountBar.style.alignItems = "center";
      accountBar.style.justifyContent = "flex-end";
      accountBar.style.gap = "10px";
      accountBar.style.flex = "0 0 auto";
    }

    qsa(".history-icon-button", accountBar).forEach((el) => {
      el.style.display = "none";
    });

    const size =
      getComputedStyle(document.documentElement).getPropertyValue("--deck-avatar-size").trim() || "48px";
    const avatarTargets = qsa(
      "#avatar-btn, ytmusic-settings-button, ytmusic-settings-button yt-icon-button, " +
        "#avatar-btn yt-img-shadow, ytmusic-settings-button yt-img-shadow, yt-img-shadow#avatar, yt-img-shadow",
      accountBar
    );
    avatarTargets.forEach((el) => {
      if (!el) return;
      el.style.width = size;
      el.style.height = size;
      el.style.minWidth = size;
      el.style.minHeight = size;
      if (el.matches("yt-img-shadow, #avatar-btn, ytmusic-settings-button, yt-icon-button")) {
        el.style.borderRadius = "50%";
        el.style.overflow = "hidden";
      }
      el.style.pointerEvents = "auto";
      el.style.touchAction = "manipulation";
    });
    qsa(
      "#avatar-btn img, ytmusic-settings-button img, ytmusic-settings-button yt-img-shadow img, yt-img-shadow img",
      accountBar
    ).forEach((img) => {
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.style.borderRadius = "50%";
      img.style.pointerEvents = "none";
    });

    syncGuideAccountBarLayout();
    mountGuideScrollWrapper();
    ensureGuideScrollLayout();
  }

  function syncGuideAccountBarLayout() {
    const slot = qs("#guide-content > .deck-guide-account-bar");
    if (!slot || document.documentElement.classList.contains("ytm-deck-playing")) return;

    const spacer = qs("#guide-spacer");
    if (spacer) {
      spacer.style.display = "none";
      spacer.style.height = "0";
      spacer.style.marginTop = "0";
    }

    const contentContainer = qs("tp-yt-app-drawer#guide #contentContainer");
    if (contentContainer) {
      contentContainer.style.padding = "0";
      contentContainer.style.paddingTop = "0";
      contentContainer.style.top = "0";
    }

    slot.style.height = "";
    slot.style.minHeight = "";
    slot.style.maxHeight = "";
    slot.style.padding = "";

    const accountBar = qs("#right-content, #button-bar", slot);
    if (accountBar) {
      accountBar.style.position = "";
      accountBar.style.top = "";
      accountBar.style.right = "";
      accountBar.style.left = "";
      accountBar.style.height = "";
      accountBar.style.minHeight = "";
      accountBar.style.transform = "";
      accountBar.style.flex = "";
    }

    const brand = qs(".deck-guide-brand", slot);
    if (!brand) return;

    const logoLeaf =
      qs("img.logo", brand) ||
      qs("ytmusic-logo", brand) ||
      qs("ytmusic-logo-renderer", brand) ||
      qs("#logo", brand);
    if (!logoLeaf) return;

    logoLeaf.style.transform = "";
    logoLeaf.style.marginTop = "0";
    logoLeaf.style.marginBottom = "0";

    const slotBox = slot.getBoundingClientRect();
    const logoBox = logoLeaf.getBoundingClientRect();
    if (!slotBox.height || !logoBox.height) return;

    const delta = slotBox.top + slotBox.height / 2 - (logoBox.top + logoBox.height / 2);
    if (Math.abs(delta) >= 1) {
      logoLeaf.style.transform = `translateY(${Math.round(delta)}px)`;
    }
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

  function getQueueThumbPx() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--deck-queue-thumb").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 64;
  }

  function injectQueueThumbnailStyle(host) {
    if (!host?.shadowRoot) return;
    const thumb = `${getQueueThumbPx()}px`;
    const old = host.shadowRoot.querySelector("[data-deck-queue-thumb-style]");
    if (old?.getAttribute("data-deck-thumb-size") === thumb) return;
    if (old) old.remove();
    const style = document.createElement("style");
    style.setAttribute("data-deck-queue-thumb-style", "2");
    style.setAttribute("data-deck-thumb-size", thumb);
    style.textContent = `
      :host {
        width: ${thumb} !important;
        height: ${thumb} !important;
        min-width: ${thumb} !important;
        min-height: ${thumb} !important;
        max-width: ${thumb} !important;
        max-height: ${thumb} !important;
        flex: 0 0 ${thumb} !important;
        --ytmusic-thumbnail-size: ${thumb} !important;
        --ytmusic-thumbnail-width: ${thumb} !important;
        --ytmusic-thumbnail-height: ${thumb} !important;
      }
      #img,
      img,
      #image,
      yt-img-shadow,
      yt-img-shadow img {
        width: 100% !important;
        height: 100% !important;
        object-fit: cover !important;
        border-radius: 4px !important;
      }
    `;
    host.shadowRoot.appendChild(style);
  }

  function syncPlayerQueueItem(item) {
    const thumb = `${getQueueThumbPx()}px`;
    item.style.setProperty("--ytmusic-player-queue-item-thumbnail-size", thumb, "important");
    item.style.setProperty("--ytmusic-thumbnail-size", thumb);
    item.style.setProperty("--deck-queue-thumb", thumb);

    qsa(
      ".left-items, yt-img-shadow.thumbnail, .thumbnail, ytmusic-item-thumbnail-overlay-renderer.thumbnail-overlay",
      item
    ).forEach((el) => {
      el.style.setProperty("width", thumb, "important");
      el.style.setProperty("height", thumb, "important");
      el.style.setProperty("min-width", thumb, "important");
      el.style.setProperty("min-height", thumb, "important");
      el.style.setProperty("max-width", thumb, "important");
      el.style.setProperty("max-height", thumb, "important");
      el.style.setProperty("flex", `0 0 ${thumb}`, "important");
    });

    const songInfo = qs(".song-info", item);
    if (songInfo) {
      songInfo.style.setProperty("display", "flex", "important");
      songInfo.style.setProperty("flex-direction", "column", "important");
      songInfo.style.setProperty("justify-content", "center", "important");
      songInfo.style.setProperty("align-self", "center", "important");
      songInfo.style.setProperty("border", "none", "important");
      songInfo.style.setProperty("box-shadow", "none", "important");
      songInfo.style.setProperty("min-height", "0", "important");
    }
  }

  function syncQueueItemThumbnail(item) {
    if (item?.tagName === "YTMUSIC-PLAYER-QUEUE-ITEM") {
      syncPlayerQueueItem(item);
      return;
    }

    const thumb = `${getQueueThumbPx()}px`;
    item.style.setProperty("--ytmusic-thumbnail-size", thumb);
    item.style.setProperty("--deck-queue-thumb", thumb);

    forEachShadowRoot(item, (root) => {
      qsa("ytmusic-thumbnail-renderer, #thumbnail, yt-img-shadow", root).forEach((el) => {
        el.style.setProperty("--ytmusic-thumbnail-size", thumb);
        el.style.setProperty("width", thumb, "important");
        el.style.setProperty("height", thumb, "important");
        el.style.setProperty("min-width", thumb, "important");
        el.style.setProperty("min-height", thumb, "important");
        el.style.setProperty("max-width", thumb, "important");
        el.style.setProperty("max-height", thumb, "important");
        el.style.setProperty("flex", `0 0 ${thumb}`, "important");
      });
      qsa("ytmusic-thumbnail-renderer", root).forEach((tr) => injectQueueThumbnailStyle(tr));
    });
  }

  const QUEUE_ITEM_SHADOW_CSS = `
    :host {
      --ytmusic-menu-renderer-button-opacity: 1 !important;
      --yt-endpoint-action-button-opacity: 1 !important;
      --ytmusic-thumbnail-size: var(--deck-queue-thumb, 64px) !important;
      display: flex !important;
      align-items: center !important;
      box-sizing: border-box !important;
      position: relative !important;
      touch-action: auto !important;
      min-height: calc(var(--deck-queue-thumb, 64px) + (var(--deck-queue-item-pad-y, 8px) * 2)) !important;
      padding: var(--deck-queue-item-pad-y, 8px) var(--deck-queue-item-pad-x, 10px) !important;
      margin: 0 !important;
      border-top: none !important;
      border-left: none !important;
      border-right: none !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 0 !important;
      overflow: hidden !important;
    }
    :host(:last-of-type) {
      border-bottom: none !important;
    }
    #content,
    .content,
    #details,
    .details,
    .text-wrapper {
      align-items: center !important;
      gap: 10px !important;
      border: none !important;
      border-bottom: none !important;
      box-shadow: none !important;
    }
    ytmusic-thumbnail-renderer,
    #thumbnail {
      width: var(--deck-queue-thumb, 64px) !important;
      height: var(--deck-queue-thumb, 64px) !important;
      min-width: var(--deck-queue-thumb, 64px) !important;
      min-height: var(--deck-queue-thumb, 64px) !important;
      flex: 0 0 var(--deck-queue-thumb, 64px) !important;
    }
    .song-title,
    .song-title a,
    yt-formatted-string.song-title {
      font-size: var(--deck-fs-queue-title, 20px) !important;
      font-weight: 600 !important;
      line-height: 1.3 !important;
    }
    .byline,
    yt-formatted-string.byline {
      font-size: var(--deck-fs-queue-meta, 17px) !important;
      line-height: 1.3 !important;
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
      width: var(--deck-queue-menu-size, 46px) !important;
      min-width: var(--deck-queue-menu-size, 46px) !important;
      max-width: var(--deck-queue-menu-size, 46px) !important;
      height: var(--deck-queue-menu-size, 46px) !important;
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
      gap: 10px !important;
      flex: 0 0 auto !important;
      margin-left: auto !important;
      min-width: var(--deck-queue-actions-min, 108px) !important;
      padding-left: 8px !important;
      position: relative !important;
      pointer-events: none !important;
    }
    .deck-queue-duration,
    .duration,
    yt-formatted-string.duration {
      order: 1 !important;
      flex: 0 0 auto !important;
      min-width: var(--deck-queue-duration-min, 44px) !important;
      margin: 0 !important;
      padding: 0 2px 0 0 !important;
      text-align: right !important;
      font-size: var(--deck-fs-queue-meta, 17px) !important;
      font-variant-numeric: tabular-nums !important;
      pointer-events: none !important;
    }
    .deck-queue-menu-proxy {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex: 0 0 var(--deck-queue-menu-size, 46px) !important;
      width: var(--deck-queue-menu-size, 46px) !important;
      min-width: var(--deck-queue-menu-size, 46px) !important;
      height: var(--deck-queue-menu-size, 46px) !important;
      min-height: var(--deck-queue-menu-size, 46px) !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 50% !important;
      background: transparent !important;
      color: rgba(220, 200, 255, 0.62) !important;
      font-size: var(--deck-queue-menu-icon, 26px) !important;
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
    const styleVersion = "7";
    const old = host.shadowRoot.querySelector("[data-deck-queue-item-style]");
    if (old?.getAttribute("data-deck-queue-item-style") === styleVersion) return;
    if (old) old.remove();
    const style = document.createElement("style");
    style.setAttribute("data-deck-queue-item-style", styleVersion);
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

  function synthClick(el) {
    if (!el) return false;
    try {
      if (typeof el.click === "function") el.click();
    } catch (_) {
      /* noop */
    }
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch (_) {
        /* noop */
      }
    }
    return true;
  }

  function findDeckHost(target, selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    let node = target;
    while (node) {
      if (node instanceof Element) {
        for (const sel of list) {
          if (node.matches?.(sel)) return node;
          const hit = node.closest?.(sel);
          if (hit) return hit;
        }
      }
      const root = node.getRootNode?.();
      if (root instanceof ShadowRoot && root.host) {
        node = root.host;
        continue;
      }
      break;
    }
    return null;
  }

  function walkUpFromTarget(target) {
    const nodes = [];
    let node = target;
    while (node) {
      nodes.push(node);
      if (node instanceof Element && node.parentElement) {
        node = node.parentElement;
        continue;
      }
      if (node.parentNode && node.parentNode !== node) {
        node = node.parentNode;
        continue;
      }
      const root = node.getRootNode?.();
      if (root instanceof ShadowRoot && root.host) {
        node = root.host;
        continue;
      }
      break;
    }
    return nodes;
  }

  function isGuideChromeTarget(target) {
    for (const node of walkUpFromTarget(target)) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(
          ".deck-guide-account-bar, #button-bar, #right-content, #avatar-btn, ytmusic-cast-button, ytmusic-settings-button"
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function isGuideScrollTarget(target, clientX, clientY) {
    if (document.documentElement.classList.contains("ytm-deck-playing")) return false;
    if (isGuideChromeTarget(target)) return false;

    for (const node of walkUpFromTarget(target)) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(
          "#contentContainer, .deck-guide-scroll, tp-yt-app-drawer#guide, #guide-content, #guide-wrapper, ytmusic-guide-renderer, ytmusic-guide-entry-renderer, #sections"
        )
      ) {
        return true;
      }
    }

    const zone = getGuideScrollRoot() || qs("tp-yt-app-drawer#guide");
    if (!zone || clientX == null || clientY == null) return false;
    const rect = zone.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function getGuideScrollRoot() {
    return (
      qs("tp-yt-app-drawer#guide #contentContainer") ||
      qs("#guide-content > .deck-guide-scroll") ||
      qs(".deck-guide-scroll")
    );
  }

  function scheduleGuideScrollMetrics() {
    if (document.documentElement.classList.contains("ytm-deck-playing")) return;
    if (guideMetricsTimer) clearTimeout(guideMetricsTimer);
    guideMetricsTimer = setTimeout(() => {
      guideMetricsTimer = null;
      forceGuideScrollMetrics();
    }, 300);
  }

  function guideScrollNeedsRepair() {
    const guideContent = qs("#guide-content");
    const renderer = getGuideRenderer();
    if (!guideContent || !renderer) return false;
    const staleWrap = qs("#guide-content > .deck-guide-scroll");
    if (staleWrap?.contains(renderer)) return true;
    return !guideContent.contains(renderer);
  }

  function mountGuideScrollWrapper() {
    const guideContent = qs("#guide-content");
    const guideRenderer = getGuideRenderer();
    const drawer = qs("tp-yt-app-drawer#guide");
    if (!guideContent || !guideRenderer || !drawer) return null;

    const wrap = qs("#guide-content > .deck-guide-scroll");
    if (wrap && guideRenderer.parentElement === wrap) {
      guideContent.insertBefore(guideRenderer, wrap.nextSibling);
    }
    if (wrap && !wrap.childElementCount) {
      wrap.remove();
    }

    const cc = qs("#contentContainer");
    if (cc) {
      const ready =
        getComputedStyle(cc).overflowY === "scroll" &&
        getComputedStyle(guideContent).overflow === "visible";
      if (!ready) {
        cc.style.setProperty("display", "block", "important");
        cc.style.setProperty("height", "100%", "important");
        cc.style.setProperty("min-height", "0", "important");
        cc.style.setProperty("overflow-x", "hidden", "important");
        cc.style.setProperty("overflow-y", "scroll", "important");
        cc.style.setProperty("-webkit-overflow-scrolling", "touch", "important");
        cc.style.setProperty("touch-action", "pan-y", "important");
        cc.style.setProperty("overscroll-behavior", "contain", "important");
      }
    }

    const wrapper = qs("#guide-wrapper");
    if (wrapper) {
      wrapper.style.setProperty("display", "block", "important");
      wrapper.style.setProperty("height", "auto", "important");
      wrapper.style.setProperty("min-height", "0", "important");
      wrapper.style.setProperty("overflow", "visible", "important");
    }

    guideContent.style.setProperty("display", "block", "important");
    guideContent.style.setProperty("height", "auto", "important");
    guideContent.style.setProperty("min-height", "0", "important");
    guideContent.style.setProperty("max-height", "none", "important");
    guideContent.style.setProperty("overflow", "visible", "important");

    guideRenderer.style.setProperty("display", "block", "important");
    guideRenderer.style.setProperty("width", "100%", "important");
    guideRenderer.style.setProperty("height", "auto", "important");
    guideRenderer.style.setProperty("max-height", "none", "important");
    guideRenderer.style.setProperty("overflow", "visible", "important");

    drawer.style.setProperty("overflow", "hidden", "important");
    drawer.style.setProperty("touch-action", "pan-y", "important");

    return cc || getGuideScrollRoot();
  }

  function forceGuideScrollMetrics() {
    return mountGuideScrollWrapper();
  }

  function ensureGuideScrollLayout() {
    forceGuideScrollMetrics();
  }

  function observeGuideScrollMetrics() {
    if (window.__YTM_DECK_GUIDE_SCROLL_OBS__) return;
    window.__YTM_DECK_GUIDE_SCROLL_OBS__ = true;
    const ro = new ResizeObserver(() => scheduleGuideScrollMetrics());
    const attach = () => {
      const drawer = qs("tp-yt-app-drawer#guide");
      const contentContainer = qs("tp-yt-app-drawer#guide #contentContainer");
      if (drawer) ro.observe(drawer);
      if (contentContainer) ro.observe(contentContainer);
    };
    attach();

    const mo = new MutationObserver(() => {
      if (guideScrollNeedsRepair()) scheduleGuideScrollMetrics();
    });
    const guideContent = qs("#guide-content");
    if (guideContent) {
      mo.observe(guideContent, { childList: true });
    }

    registerTouchReset(() => scheduleGuideScrollMetrics());
  }

  function getGuideScroller() {
    forceGuideScrollMetrics();
    return (
      pickBestScroller(collectGuideScrollCandidates()) ||
      qs("tp-yt-app-drawer#guide #contentContainer") ||
      getGuideScrollRoot()
    );
  }

  function collectGuideScrollCandidates() {
    return [
      qs("tp-yt-app-drawer#guide #contentContainer"),
      getGuideScrollRoot(),
      mountGuideScrollWrapper(),
      getGuideRenderer(),
    ];
  }

  function findScrollableAncestor(target) {
    let best = null;
    let bestOverflow = 0;
    for (const node of walkUpFromTarget(target)) {
      if (!(node instanceof Element)) continue;
      const overflow = node.scrollHeight - node.clientHeight;
      if (overflow > bestOverflow) {
        best = node;
        bestOverflow = overflow;
      }
    }
    return bestOverflow > 2 ? best : null;
  }

  function getGuideRenderer() {
    return (
      qs("#guide-content > ytmusic-guide-renderer") ||
      qs("#guide-content > .deck-guide-scroll > ytmusic-guide-renderer") ||
      qs("tp-yt-app-drawer#guide ytmusic-guide-renderer") ||
      qs("ytmusic-guide-renderer")
    );
  }

  function isVerticallyScrollable(el) {
    if (!el || !(el instanceof Element)) return false;
    return el.scrollHeight > el.clientHeight + 2;
  }

  function pickBestScroller(candidates) {
    const unique = [];
    for (const el of candidates) {
      if (!el || unique.includes(el)) continue;
      unique.push(el);
    }
    let best = null;
    let bestOverflow = 0;
    for (const el of unique) {
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow > bestOverflow) {
        best = el;
        bestOverflow = overflow;
      }
    }
    return bestOverflow > 2 ? best : null;
  }

  function bindGuideTouchScroll() {
    if (window.__YTM_DECK_GUIDE_SCROLL_BOUND__) return;
    window.__YTM_DECK_GUIDE_SCROLL_BOUND__ = true;

    let drag = null;
    let suppressClickUntil = 0;

    const clearDrag = () => {
      drag = null;
    };

    const findTouch = (event, id) => {
      for (const list of [event.touches, event.changedTouches]) {
        if (!list) continue;
        for (const touch of list) {
          if (touch.identifier === id) return touch;
        }
      }
      return null;
    };

    const startDrag = (id, x, y, target, source) => {
      if (!isGuideScrollTarget(target, x, y)) return;
      if (drag && drag.source !== source) return;
      if (drag) return;
      const scroller = getGuideScroller();
      if (!scroller) return;
      drag = {
        id,
        x,
        y,
        scroller,
        top: scroller.scrollTop,
        moved: false,
        source,
      };
    };

    const moveDrag = (id, x, y, event) => {
      if (!drag || drag.id !== id) return;
      const dy = y - drag.y;
      if (Math.abs(dy) < 4) return;
      drag.moved = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      const maxTop = Math.max(0, drag.scroller.scrollHeight - drag.scroller.clientHeight);
      drag.scroller.scrollTop = Math.max(0, Math.min(maxTop, drag.top - dy));
    };

    const endDrag = (id, event) => {
      if (!drag || drag.id !== id) return;
      if (drag.moved) {
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
        suppressClickUntil = performance.now() + SCROLL_DRAG_SUPPRESS_MS;
      }
      clearDrag();
    };

    document.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.changedTouches[0];
        if (!touch) return;
        startDrag(touch.identifier, touch.clientX, touch.clientY, event.target, "touch");
      },
      { capture: true, passive: true }
    );

    document.addEventListener(
      "touchmove",
      (event) => {
        if (!drag || drag.source !== "touch") return;
        const touch = findTouch(event, drag.id);
        if (!touch) return;
        moveDrag(touch.identifier, touch.clientX, touch.clientY, event);
      },
      { capture: true, passive: false }
    );

    document.addEventListener(
      "touchend",
      (event) => {
        if (!drag || drag.source !== "touch") return;
        const touch = findTouch(event, drag.id);
        if (!touch) return;
        endDrag(touch.identifier, event);
      },
      { capture: true, passive: false }
    );

    document.addEventListener(
      "touchcancel",
      (event) => {
        if (!drag || drag.source !== "touch") return;
        const touch = findTouch(event, drag.id);
        if (!touch) return;
        endDrag(touch.identifier, event);
      },
      { capture: true, passive: false }
    );

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        if (drag?.source === "touch") return;
        startDrag(event.pointerId, event.clientX, event.clientY, event.target, "pointer");
      },
      { capture: true }
    );

    document.addEventListener(
      "pointermove",
      (event) => {
        if (!drag || drag.source !== "pointer") return;
        moveDrag(event.pointerId, event.clientX, event.clientY, event);
      },
      { capture: true, passive: false }
    );

    document.addEventListener("pointerup", (event) => {
      if (!drag || drag.source !== "pointer") return;
      endDrag(event.pointerId, event);
    }, { capture: true });

    document.addEventListener("pointercancel", (event) => {
      if (!drag || drag.source !== "pointer") return;
      endDrag(event.pointerId, event);
    }, { capture: true });

    document.addEventListener(
      "wheel",
      (event) => {
        if (!isGuideScrollTarget(event.target, event.clientX, event.clientY)) return;
        const scroller = getGuideScroller();
        if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 2) return;
        event.preventDefault();
        scroller.scrollTop += event.deltaY;
      },
      { capture: true, passive: false }
    );

    document.addEventListener(
      "click",
      (event) => {
        if (!isGuideScrollTarget(event.target, event.clientX, event.clientY)) return;
        if (performance.now() < suppressClickUntil) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );

    registerTouchReset(clearDrag);
  }

  function getQueueItemFromThumbnail(target, clientX, clientY) {
    if (!target) return null;

    const findQueueItemHost = (el) => {
      let node = el;
      while (node) {
        if (node instanceof Element) {
          if (
            node.matches?.(
              "ytmusic-queue-item, ytmusic-playlist-panel-video-renderer, ytmusic-player-queue-item"
            ) &&
            qs("#side-panel")?.contains(node)
          ) {
            return node;
          }
          const inPanel = node.closest?.(
            "#side-panel ytmusic-queue-item, #side-panel ytmusic-playlist-panel-video-renderer, #side-panel ytmusic-player-queue-item"
          );
          if (inPanel) return inPanel;
        }
        const root = node.getRootNode?.();
        if (root instanceof ShadowRoot && root.host) {
          node = root.host;
          continue;
        }
        break;
      }
      return null;
    };

    const item = findQueueItemHost(target);
    if (!item) return null;

    if (
      findDeckHost(target, [
        ".deck-queue-menu-proxy",
        "ytmusic-menu-renderer",
        "ytmusic-item-menu-renderer",
        ".deck-queue-actions",
        ".deck-queue-duration",
        "#menu",
        "button",
        "yt-icon-button",
        "tp-yt-paper-icon-button",
      ])
    ) {
      return null;
    }
    if (findDeckHost(target, [".song-title", ".byline", ".text-wrapper", ".subtitle"])) return null;

    if (
      findDeckHost(target, [
        "ytmusic-thumbnail-renderer",
        "ytmusic-playlist-thumbnail",
        "#thumbnail",
        ".thumbnail",
        "yt-img-shadow",
      ])
    ) {
      return item;
    }
    if (target.tagName === "IMG") return item;

    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const rect = item.getBoundingClientRect();
      const thumbWidth = Math.min(112, Math.max(72, rect.width * 0.34));
      if (
        clientX >= rect.left - 4 &&
        clientX <= rect.left + thumbWidth + 10 &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return item;
      }
    }
    return null;
  }

  function playQueueItemFromThumbnail(item) {
    if (!item) return false;

    const tryRoots = (roots) => {
      for (const root of roots) {
        const playBtn =
          qs("ytmusic-play-button-renderer button", root) ||
          qs("ytmusic-play-button-renderer", root) ||
          qs("#play-button", root);
        if (playBtn && synthClick(playBtn)) return true;

        const thumbLink =
          qs("ytmusic-thumbnail-renderer a.yt-simple-endpoint", root) ||
          qs("#thumbnail a.yt-simple-endpoint", root) ||
          qs("a.yt-simple-endpoint", root) ||
          qs("#navigation-endpoint", root);
        if (thumbLink && synthClick(thumbLink)) return true;

        const thumb = qs("ytmusic-thumbnail-renderer, #thumbnail", root);
        if (thumb && synthClick(thumb)) return true;

        const title = qs(".song-title a", root) || qs(".song-title", root);
        if (title && synthClick(title)) return true;
      }
      return false;
    };

    const roots = [item];
    forEachShadowRoot(item, (root) => roots.push(root));
    if (tryRoots(roots)) return true;

    synthClick(item);
    setTimeout(() => {
      if (!tryRoots(roots)) synthClick(item);
    }, 60);
    return true;
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

  let lastDeckBackAt = 0;
  let lastGamepadBAt = 0;

  function isRecentGamepadB(maxMs) {
    return performance.now() - lastGamepadBAt < (maxMs || 280);
  }

  function deckBack(opts) {
    // B del mando: minimizar / atrás.
    // Escape suelto (menú Steam/Decky) NO debe tocar el reproductor.
    const fromEscape = !!(opts && opts.fromEscape);
    const allowMinimize = !fromEscape || isRecentGamepadB(320);
    const allowHistory = !fromEscape || isRecentGamepadB(320);

    const now = performance.now();
    if (now - lastDeckBackAt < 450) return;
    lastDeckBackAt = now;

    if (closeOpenPopups()) return;

    const bar = qs("ytmusic-player-bar");
    const polyOpen = !!bar?.playerPageOpen;
    const pageOpen = isPlayerPageOpen();

    // Solo minimizar con B real del control (o Escape acoplado a ese B).
    if (pageOpen || polyOpen) {
      if (!allowMinimize) return;
      closePlayerPage();
      return;
    }

    // Clase deck colgada sin página abierta: limpiar y seguir atrás.
    if (document.documentElement.classList.contains("ytm-deck-playing")) {
      exitPlayingViewForced();
    }

    const searchOpen = qs("ytmusic-search-box[opened], ytmusic-search-box[visible]");
    if (searchOpen) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return;
    }

    if (!allowHistory) return;
    navigateHistoryBack();
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

    const guide = getGuideRenderer() || qs("tp-yt-app-drawer#guide #guide-content, #guide-content");
    if (guide) {
      ensureGuideScrollLayout();
      const guideScroller = getGuideScroller();
      if (guideScroller) return guideScroller;
    }

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

  function isSidePanelTabTarget(target) {
    return !!target?.closest?.(
      "#side-panel tp-yt-paper-tab, #side-panel paper-tab, #side-panel tp-yt-paper-tabs, " +
        "#side-panel .tab-header-container, #side-panel #tabs, #side-panel .tab-header"
    );
  }

  function isScrollControl(target) {
    if (isSidePanelTabTarget(target)) return true;
    return !!target.closest(
      "button, input, textarea, select, ytmusic-player-bar, .deck-queue-menu-proxy, " +
        "tp-yt-paper-slider, ytmusic-play-button-renderer, ytmusic-menu-renderer, " +
        "ytmusic-item-menu-renderer, tp-yt-paper-tab, #avatar-btn, #button-bar, #right-content, " +
        ".deck-guide-account-bar, ytmusic-nav-bar #button-bar, ytmusic-nav-bar #right-content, " +
        "ytmusic-cast-button, ytmusic-settings-button"
    );
  }

  function isCarouselScrollTarget(target) {
    const carousel = target.closest?.(
      "ytmusic-carousel #items, ytmusic-carousel .items-wrapper, ytmusic-carousel-shelf-renderer #items"
    );
    if (carousel && carousel.scrollWidth > carousel.clientWidth + 4) return carousel;

    const chipCloud = target.closest?.("ytmusic-chip-cloud-renderer, .chip-cloud-renderer");
    if (!chipCloud) return null;
    const chipScroller =
      qs("#scroll-container", chipCloud) ||
      qs("#chips-wrapper", chipCloud) ||
      qs(".chip-cloud-content", chipCloud) ||
      chipCloud;
    return chipScroller.scrollWidth > chipScroller.clientWidth + 4 ? chipScroller : null;
  }

  function preferHorizontalAxis(dx, dy) {
    return Math.abs(dx) > Math.abs(dy) * SCROLL_AXIS_RATIO;
  }

  function preferVerticalAxis(dx, dy) {
    return Math.abs(dy) > Math.abs(dx) * SCROLL_AXIS_RATIO;
  }

  function bindPreventLinkDrag() {
    if (window.__YTM_DECK_NO_LINK_DRAG__) return;
    window.__YTM_DECK_NO_LINK_DRAG__ = true;

    document.addEventListener(
      "dragstart",
      (event) => {
        if (!document.documentElement.hasAttribute("data-ytm-deck")) return;
        if (
          event.target.closest(
            "a, .yt-simple-endpoint, tp-yt-paper-item, ytmusic-guide-entry-renderer, ytmusic-multi-carousel-item-renderer, ytmusic-two-row-item-renderer, " +
              "#side-panel ytmusic-playlist-panel-video-renderer, #side-panel ytmusic-queue-item, #side-panel ytmusic-player-queue-item"
          )
        ) {
          event.preventDefault();
        }
      },
      true
    );
  }

  function bindTouchGestures() {
    if (window.__YTM_DECK_TOUCH_GESTURES__) return;
    window.__YTM_DECK_TOUCH_GESTURES__ = true;

    bindPreventLinkDrag();
    observeGuideScrollMetrics();
    bindGuideTouchScroll();

    const MODE = { PENDING: "pending", H_SCROLL: "hscroll", V_SCROLL: "vscroll", REORDER: "reorder" };
    let gesture = null;
    let suppressClickUntil = 0;

    const clearGesture = () => {
      if (!gesture) return;
      if (gesture.edgeTimer) {
        clearInterval(gesture.edgeTimer);
        gesture.edgeTimer = null;
      }
      if (gesture.item) delete gesture.item.dataset.deckReorderOk;
      gesture.reorderCandidate = null;
      if (gesture.mode === MODE.REORDER) setQueueReordering(false);
      try {
        gesture.scroller?.releasePointerCapture?.(gesture.id);
      } catch (_) {
        /* noop */
      }
      gesture = null;
      document.documentElement.classList.remove("ytm-deck-dragging");
    };

    const clearSelection = () => {
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    };

    const stopEdgeScroll = () => {
      if (!gesture?.edgeTimer) return;
      clearInterval(gesture.edgeTimer);
      gesture.edgeTimer = null;
      gesture.edgeDir = 0;
    };

    const startEdgeScroll = (direction) => {
      if (!gesture || gesture.mode !== MODE.REORDER) return;
      if (gesture.edgeDir === direction && gesture.edgeTimer) return;
      stopEdgeScroll();
      gesture.edgeDir = direction;
      gesture.edgeTimer = setInterval(() => {
        if (!gesture || gesture.mode !== MODE.REORDER || !gesture.scroller) {
          stopEdgeScroll();
          return;
        }
        const scroller = gesture.scroller;
        const next = scroller.scrollTop + direction * QUEUE_EDGE_SCROLL_STEP;
        scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, next));
        gesture.lockTop = scroller.scrollTop;
      }, 28);
    };

    const resolveVerticalScroller = (target) => {
      if (isScrollControl(target)) return null;

      const queueItem = findDeckHost(target, [
        "ytmusic-queue-item",
        "ytmusic-playlist-panel-video-renderer",
        "ytmusic-player-queue-item",
      ]);
      if (queueItem && qs("#side-panel")?.contains(queueItem)) {
        const scroller = getQueueScroller(queueItem);
        if (scroller) return { scroller, item: null, reorderCandidate: queueItem };
      }

      const queueTab = findDeckHost(target, [
        "ytmusic-queue-tab",
        "ytmusic-tab-renderer",
        "#tab-renderer",
      ]);
      if (queueTab && qs("#side-panel")?.contains(queueTab)) {
        const scroller = pickBestScroller([queueTab, getQueueScroller(queueTab)]);
        if (scroller) return { scroller, item: null };
      }

      if (!document.documentElement.classList.contains("ytm-deck-playing")) {
        const guideHit = findDeckHost(target, [
          "ytmusic-guide-entry-renderer",
          "ytmusic-guide-renderer",
          "#guide-content",
          "#guide-wrapper",
          "#sections",
          "tp-yt-app-drawer#guide",
        ]);
      if (guideHit) {
        if (target.closest?.(".deck-guide-account-bar, #button-bar, #right-content, #avatar-btn, ytmusic-cast-button, ytmusic-settings-button")) {
          return null;
        }
        ensureGuideScrollLayout();
        const scroller = getGuideScroller();
        if (scroller) return { scroller, item: null };
      }
      }

      const browse = findDeckHost(target, [
        "ytmusic-browse-response",
        "ytmusic-search-response",
        "ytmusic-section-list-renderer",
      ]);
      if (browse) {
        const scroller = pickBestScroller([browse, findDeckHost(target, ["#content"])]);
        if (scroller) return { scroller, item: null };
      }

      const content = findDeckHost(target, ["#content"]);
      if (content) return { scroller: content, item: null };

      return null;
    };

    document.addEventListener(
      "click",
      (event) => {
        if (performance.now() < suppressClickUntil) {
          if (isSidePanelTabTarget(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true
    );

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        if (isScrollControl(event.target)) return;
        if (isGuideScrollTarget(event.target, event.clientX, event.clientY)) return;

        clearGesture();

        const carousel = isCarouselScrollTarget(event.target);
        const vertical = resolveVerticalScroller(event.target);

        if (carousel) {
          gesture = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            t: performance.now(),
            mode: MODE.PENDING,
            kind: "ambivalent",
            scroller: carousel,
            left: carousel.scrollLeft,
            top: vertical?.scroller?.scrollTop ?? 0,
            verticalScroller: vertical?.scroller || null,
            item: null,
            edgeTimer: null,
            edgeDir: 0,
          };
          return;
        }

        if (!vertical) return;

        if (vertical.reorderCandidate) {
          event.preventDefault();
        }

        gesture = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          t: performance.now(),
          mode: MODE.PENDING,
          kind: "vertical",
          scroller: vertical.scroller,
          top: vertical.scroller.scrollTop,
          lockTop: vertical.scroller.scrollTop,
          item: vertical.item,
          reorderCandidate: vertical.reorderCandidate || null,
          thumbItem: getQueueItemFromThumbnail(event.target, event.clientX, event.clientY),
          edgeTimer: null,
          edgeDir: 0,
        };
      },
      true
    );

    document.addEventListener(
      "pointermove",
      (event) => {
        if (!gesture || event.pointerId !== gesture.id) return;

        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        const dist = Math.hypot(dx, dy);
        const elapsed = performance.now() - gesture.t;

        if (gesture.mode === MODE.PENDING) {
          if (gesture.kind === "ambivalent") {
            if (dist < SCROLL_DRAG_THRESHOLD) return;
            if (preferHorizontalAxis(dx, dy)) {
              gesture.mode = MODE.H_SCROLL;
              gesture.kind = "horizontal";
              gesture.left = gesture.scroller.scrollLeft;
            } else if (preferVerticalAxis(dx, dy) && gesture.verticalScroller) {
              gesture.mode = MODE.V_SCROLL;
              gesture.kind = "vertical";
              gesture.scroller = gesture.verticalScroller;
              gesture.top = gesture.verticalScroller.scrollTop;
              gesture.lockTop = gesture.verticalScroller.scrollTop;
            } else if (preferVerticalAxis(dx, dy)) {
              clearGesture();
              return;
            } else {
              return;
            }
            document.documentElement.classList.add("ytm-deck-dragging");
            clearSelection();
            try {
              gesture.scroller.setPointerCapture?.(event.pointerId);
            } catch (_) {
              /* noop */
            }
          } else if (gesture.reorderCandidate) {
            const verticalIntent =
              Math.abs(dy) >= QUEUE_VERTICAL_CANCEL ||
              (dist >= SCROLL_DRAG_THRESHOLD && preferVerticalAxis(dx, dy));
            if (verticalIntent || dist > QUEUE_MOVE_SLOP) {
              gesture.mode = MODE.V_SCROLL;
              gesture.reorderCandidate = null;
              document.documentElement.classList.add("ytm-deck-dragging");
              clearSelection();
              try {
                gesture.scroller.setPointerCapture?.(event.pointerId);
              } catch (_) {
                /* noop */
              }
            } else if (elapsed >= QUEUE_LONG_PRESS_MS && dist <= QUEUE_REORDER_MAX_MOVE) {
              gesture.mode = MODE.REORDER;
              gesture.item = gesture.reorderCandidate;
              gesture.reorderCandidate = null;
              gesture.item.dataset.deckReorderOk = "1";
              gesture.lockTop = gesture.scroller.scrollTop;
              setQueueReordering(true);
              return;
            } else {
              return;
            }
          } else {
            if (dist < SCROLL_DRAG_THRESHOLD) return;
            if (!preferVerticalAxis(dx, dy)) {
              if (preferHorizontalAxis(dx, dy)) {
                clearGesture();
              }
              return;
            }
            gesture.mode = MODE.V_SCROLL;
            document.documentElement.classList.add("ytm-deck-dragging");
            clearSelection();
            try {
              gesture.scroller.setPointerCapture?.(event.pointerId);
            } catch (_) {
              /* noop */
            }
          }
        }

        if (gesture.mode === MODE.H_SCROLL) {
          event.preventDefault();
          gesture.scroller.scrollLeft = gesture.left - dx;
          return;
        }

        if (gesture.mode === MODE.V_SCROLL) {
          event.preventDefault();
          gesture.scroller.scrollTop = gesture.top - dy;
          return;
        }

        if (gesture.mode === MODE.REORDER) {
          const scroller = gesture.scroller;
          const rect = scroller.getBoundingClientRect();
          const y = event.clientY;
          const nearTop = y <= rect.top + QUEUE_EDGE_SCROLL_PX;
          const nearBottom = y >= rect.bottom - QUEUE_EDGE_SCROLL_PX;

          if (nearTop) {
            startEdgeScroll(-1);
            scroller.scrollTop = Math.max(0, scroller.scrollTop - QUEUE_EDGE_SCROLL_STEP);
            gesture.lockTop = scroller.scrollTop;
          } else if (nearBottom) {
            startEdgeScroll(1);
            scroller.scrollTop = Math.min(
              scroller.scrollHeight - scroller.clientHeight,
              scroller.scrollTop + QUEUE_EDGE_SCROLL_STEP
            );
            gesture.lockTop = scroller.scrollTop;
          } else {
            stopEdgeScroll();
            if (gesture.lockTop != null && Math.abs(scroller.scrollTop - gesture.lockTop) > 0.5) {
              scroller.scrollTop = gesture.lockTop;
            }
          }
        }
      },
      { capture: true, passive: false }
    );

    const finishGesture = (event) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const g = gesture;
      const wasScroll = g.mode === MODE.H_SCROLL || g.mode === MODE.V_SCROLL;
      clearGesture();

      if (wasScroll) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickUntil = performance.now() + SCROLL_DRAG_SUPPRESS_MS;
      }
    };

    document.addEventListener("pointerup", finishGesture, true);
    document.addEventListener("pointercancel", finishGesture, true);

    registerTouchReset(() => {
      clearGesture();
      suppressClickUntil = 0;
    });
  }

  function bindQueueThumbnailTap() {
    if (window.__YTM_DECK_QUEUE_THUMB_TAP__) return;
    window.__YTM_DECK_QUEUE_THUMB_TAP__ = true;

    let thumbTap = null;

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        const item = getQueueItemFromThumbnail(event.target, event.clientX, event.clientY);
        if (!item) return;
        thumbTap = {
          item,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          t: performance.now(),
        };
      },
      true
    );

    document.addEventListener(
      "pointermove",
      (event) => {
        if (!thumbTap || event.pointerId !== thumbTap.id) return;
        if (Math.hypot(event.clientX - thumbTap.x, event.clientY - thumbTap.y) > QUEUE_MOVE_SLOP) {
          thumbTap = null;
        }
      },
      true
    );

    document.addEventListener(
      "pointerup",
      (event) => {
        if (!thumbTap || event.pointerId !== thumbTap.id) return;
        const elapsed = performance.now() - thumbTap.t;
        const dist = Math.hypot(event.clientX - thumbTap.x, event.clientY - thumbTap.y);
        const item = thumbTap.item;
        thumbTap = null;
        if (elapsed > QUEUE_TAP_MS || dist > QUEUE_MOVE_SLOP) return;
        if (document.documentElement.classList.contains("ytm-deck-queue-reordering")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        playQueueItemFromThumbnail(item);
      },
      true
    );

    document.addEventListener(
      "pointercancel",
      (event) => {
        if (thumbTap && event.pointerId === thumbTap.id) thumbTap = null;
      },
      true
    );

    registerTouchReset(() => {
      thumbTap = null;
    });
  }

  function bindSidePanelTabTouch() {
    if (window.__YTM_DECK_SIDE_TAB_TOUCH__) return;
    window.__YTM_DECK_SIDE_TAB_TOUCH__ = true;

    const tabFrom = (target) =>
      target?.closest?.("#side-panel tp-yt-paper-tab, #side-panel paper-tab");

    let tabTap = null;

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        const tab = tabFrom(event.target);
        if (!tab) return;
        tabTap = {
          tab,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          t: performance.now(),
        };
      },
      true
    );

    document.addEventListener(
      "pointermove",
      (event) => {
        if (!tabTap || event.pointerId !== tabTap.id) return;
        if (Math.hypot(event.clientX - tabTap.x, event.clientY - tabTap.y) > QUEUE_MOVE_SLOP) {
          tabTap = null;
        }
      },
      true
    );

    document.addEventListener(
      "pointerup",
      (event) => {
        if (!tabTap || event.pointerId !== tabTap.id) return;
        const elapsed = performance.now() - tabTap.t;
        const dist = Math.hypot(event.clientX - tabTap.x, event.clientY - tabTap.y);
        const tab = tabTap.tab;
        tabTap = null;
        if (elapsed > QUEUE_TAP_MS || dist > QUEUE_MOVE_SLOP) return;
        event.preventDefault();
        event.stopPropagation();
        sideTabUserPicked = true;
        tab.click();
        setTimeout(paintDeckAccentTabs, 0);
        setTimeout(paintDeckAccentTabs, 120);
      },
      true
    );

    document.addEventListener(
      "pointercancel",
      (event) => {
        if (tabTap && event.pointerId === tabTap.id) tabTap = null;
      },
      true
    );

    registerTouchReset(() => {
      tabTap = null;
    });
  }

  function bindPointerScrollDrag() {
    bindAppLifecycleTouchReset();
    bindTouchCursorHide();
    bindTouchGestures();
    bindQueueThumbnailTap();
    bindSidePanelTabTouch();
  }

  function bindDeckInput() {
    if (window.__YTM_DECK_INPUT_BOUND__) return;
    window.__YTM_DECK_INPUT_BOUND__ = true;

    bindPointerScrollDrag();

    const STICK_DEADZONE = 0.28;
    const prevButtons = new Map();

    document.addEventListener(
      "keydown",
      (event) => {
        if (isTextField(event.target)) return;
        if (event.key === "Escape") {
          // Tragar siempre: si no, YTM / overlays reaccionan al Escape del menú Steam/Decky.
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
          // Solo si el Escape viene del B del mando (Steam a veces traduce B→Escape).
          deckBack({ fromEscape: true });
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

    // Al navegar con history, re-sincronizar la vista deck (sin reabrir tras B).
    window.addEventListener("popstate", () => {
      setTimeout(() => {
        if (isPlayerToggleProgrammatic()) return;
        syncPlayingView();
      }, 100);
    });

    window.addEventListener("gamepadconnected", () => {
      logBridge("gamepad conectado");
    });

    const pollGamepad = () => {
      const pads = navigator.getGamepads?.() || [];
      for (const pad of pads) {
        if (!pad) continue;
        const prev = prevButtons.get(pad.index) || [];

        if (pad.buttons[0]?.pressed && !prev[0]) deckActivate();
        if (pad.buttons[1]?.pressed && !prev[1]) {
          lastGamepadBAt = performance.now();
          deckBack();
        }

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

  function getQueueScroller(item) {
    return (
      item.closest(
        "#side-panel ytmusic-queue-tab, #side-panel ytmusic-tab-renderer, #side-panel #tab-renderer, #side-panel"
      ) || qs("#side-panel ytmusic-queue-tab, #side-panel ytmusic-tab-renderer")
    );
  }

  function setQueueReordering(on) {
    document.documentElement.classList.toggle("ytm-deck-queue-reordering", on);
  }

  function bindQueuePanelTouch() {
    const panel = qs("#side-panel");
    if (!panel || panel.dataset.deckQueueTouchBound) return;
    panel.dataset.deckQueueTouchBound = "1";

    const TAP_MS = 320;
    const itemFrom = (target) =>
      target?.closest?.(
        "ytmusic-playlist-panel-video-renderer, ytmusic-queue-item, ytmusic-player-queue-item"
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
      syncQueueItemThumbnail(item);
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
    const bar = qs("ytmusic-player-bar");
    if (bar) syncDeckMediaInfo(bar);
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
    if (titleEl) titleEl.textContent = barTitle || "";
    if (artistEl) artistEl.textContent = barArtist || "";

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
    const playing = document.documentElement.classList.contains("ytm-deck-playing");
    const heroFlex = playing
      ? wide
        ? "0 0 54%"
        : "0 0 50%"
      : wide
        ? "0 0 52%"
        : "0 0 48%";
    const queueFlex = playing ? (wide ? "1 1 46%" : "1 1 50%") : wide ? "1 1 48%" : "1 1 52%";
    const hero = qs(".deck-hero-wrap");
    if (hero) {
      hero.style.flex = heroFlex;
      hero.style.maxWidth = playing ? (wide ? "54%" : "50%") : wide ? "52%" : "48%";
    }
    if (content) {
      content.style.display = "flex";
      content.style.flex = queueFlex;
      content.style.minWidth = wide ? "280px" : "300px";
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

  function clickPlayerPageToggle(bar) {
    return togglePlayerPageView();
  }

  function bindPlayerToggle() {
    if (window.__YTM_DECK_TOGGLE_V4__) return;
    window.__YTM_DECK_TOGGLE_V4__ = true;

    let toggleWasOpen = null;

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (isPlayerToggleProgrammatic()) return;
        if (!event.target.closest("ytmusic-player-bar .toggle-player-page-button")) return;
        if (event.button !== 0) return;
        toggleWasOpen = isPlayerPageOpen();
      },
      true
    );

    document.addEventListener(
      "pointerup",
      (event) => {
        if (isPlayerToggleProgrammatic()) {
          toggleWasOpen = null;
          return;
        }
        if (!event.target.closest("ytmusic-player-bar .toggle-player-page-button")) return;
        if (event.button !== 0 && event.pointerType !== "touch") return;

        const wasOpen = toggleWasOpen;
        toggleWasOpen = null;
        setTimeout(() => {
          if (isPlayerToggleProgrammatic()) return;
          const nowOpen = isPlayerPageOpen();
          if (wasOpen === true && nowOpen === false) {
            syncPlayingView();
            return;
          }
          if (wasOpen === false && nowOpen === true) {
            syncPlayingView();
            return;
          }
          // Solo corregir toques reales del usuario si YTM no cambió el DOM.
          if (wasOpen === false && nowOpen === false) openPlayerPage();
          else if (wasOpen === true && nowOpen === true) closePlayerPage();
        }, 80);
      },
      false
    );
  }

  const PLAYER_OPEN_TARGETS =
    ".toggle-player-page-button, .thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer";
  const PLAYER_BAR_INTERACTIVE =
    "yt-icon-button, tp-yt-paper-icon-button, tp-yt-paper-slider, #volume-slider, #progress-bar, button, a.yt-simple-endpoint, .left-controls-buttons, .right-controls-buttons, .middle-controls-buttons, .play-pause-button, .next-button, .previous-button, .toggle-player-page-button";

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

    bar.addEventListener(
      "click",
      (event) => {
        if (isPlayerPageOpen()) return;
        if (!event.target.closest(".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer")) return;
        setTimeout(() => {
          if (!isPlayerPageOpen()) openPlayerPage();
          else syncPlayingView();
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
      drawer.style.overflowY = "hidden";
    }
    hideGuideCloseButtons();
    ensureGuideScrollLayout();
    observeGuideScrollMetrics();
    bindGuideTouchScroll();
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

  function bindPlayerBarTitleWatch(bar) {
    if (!bar || bar.dataset.deckTitleWatch === "1") return;
    bar.dataset.deckTitleWatch = "1";

    let syncTimer = null;
    const scheduleSync = () => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = null;
        syncPlayerBarTitleMarquee(bar);
        syncDeckMediaInfo(bar);
        scheduleDeckMediaMarqueeMeasure(bar);
        const heroTitle = qs(".deck-now-playing-meta .deck-title");
        const heroArtist = qs(".deck-now-playing-meta .deck-artist");
        const title = readSongTitle();
        const artist = readSongArtist();
        if (heroTitle) heroTitle.textContent = title || "";
        if (heroArtist) heroArtist.textContent = artist || "";
      }, 40);
    };

    const observer = new MutationObserver(scheduleSync);
    observer.observe(bar, { childList: true, subtree: true, characterData: true });

    const queueRoot =
      qs("#side-panel ytmusic-queue-tab") ||
      qs("ytmusic-queue-tab") ||
      qs("#side-panel");
    if (queueRoot) {
      observer.observe(queueRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["selected"],
      });
    }
  }

  function bindPlayerBarThumbnailEvents() {
    const bar = qs("ytmusic-player-bar");
    if (!bar || bar.dataset.deckThumbBound === "1") return;
    bar.dataset.deckThumbBound = "1";
    bindPlayerBarTitleWatch(bar);
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

  function readPlayerBarTitleText(titleEl) {
    if (!titleEl) return "";
    const ytm = titleEl.querySelector("yt-formatted-string, a.yt-simple-endpoint");
    if (ytm && !ytm.closest(".deck-title-marquee")) {
      const text = (ytm.textContent || "").trim();
      if (text) return text;
    }
    const bar = titleEl.closest("ytmusic-player-bar");
    return readLivePlayerBarTitle(bar);
  }

  function measureDeckLineMarquee(wrap) {
    if (!wrap?.isConnected) return;
    const primary = wrap.querySelector(".deck-title-marquee-text");
    const inner = wrap.querySelector(".deck-title-marquee-inner");
    if (!primary || !inner) return;

    const overflows = primary.scrollWidth > wrap.clientWidth + 2;
    wrap.classList.toggle("deck-title-marquee-active", overflows);

    if (overflows) {
      const gapPx = 32;
      const distance = primary.scrollWidth + gapPx;
      const duration = Math.max(8, Math.min(22, distance / 22));
      inner.style.setProperty("--deck-marquee-end", `-${distance}px`);
      inner.style.setProperty("--deck-marquee-duration", `${duration}s`);
    } else {
      inner.style.removeProperty("--deck-marquee-end");
      inner.style.removeProperty("--deck-marquee-duration");
    }
  }

  function remeasureDeckMediaMarquees(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return;
    qsa(".deck-media-title .deck-title-marquee, .deck-media-artist .deck-title-marquee", bar).forEach(
      measureDeckLineMarquee
    );
  }

  function scheduleDeckMediaMarqueeMeasure(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return;
    remeasureDeckMediaMarquees(bar);
    requestAnimationFrame(() => {
      remeasureDeckMediaMarquees(bar);
      requestAnimationFrame(() => remeasureDeckMediaMarquees(bar));
    });
    setTimeout(() => remeasureDeckMediaMarquees(bar), 120);
  }

  function applyDeckMediaLineMarquee(hostEl, text, opts) {
    if (!hostEl) return;

    const dataKey = opts?.dataKey || "deckLastText";
    let wrap = qs(".deck-title-marquee", hostEl);
    const currentText = (text || "").trim();

    if (!currentText) {
      wrap?.remove();
      hostEl.classList.remove("deck-has-marquee");
      hostEl.textContent = "";
      delete hostEl.dataset[dataKey];
      return;
    }

    hostEl.dataset[dataKey] = currentText;

    if (wrap && wrap.dataset.deckOriginalText !== currentText) {
      wrap.remove();
      wrap = null;
    }

    hostEl.classList.add("deck-has-marquee");

    if (!wrap) {
      hostEl.textContent = "";
      wrap = document.createElement("div");
      wrap.className = "deck-title-marquee";
      wrap.dataset.deckOriginalText = currentText;

      const inner = document.createElement("div");
      inner.className = "deck-title-marquee-inner";

      const primary = document.createElement("span");
      primary.className = "deck-title-marquee-text";
      primary.textContent = currentText;

      const gap = document.createElement("span");
      gap.className = "deck-title-marquee-gap";
      gap.setAttribute("aria-hidden", "true");
      gap.textContent = "\u00a0";

      const copy = document.createElement("span");
      copy.className = "deck-title-marquee-text deck-title-marquee-copy";
      copy.setAttribute("aria-hidden", "true");
      copy.textContent = currentText;

      inner.append(primary, gap, copy);
      wrap.appendChild(inner);
      hostEl.appendChild(wrap);
    } else {
      wrap.dataset.deckOriginalText = currentText;
      qsa(".deck-title-marquee-text", wrap).forEach((node) => {
        node.textContent = currentText;
      });
    }

    measureDeckLineMarquee(wrap);
    requestAnimationFrame(() => measureDeckLineMarquee(wrap));
  }

  function applyDeckMediaTitleMarquee(titleEl, text) {
    applyDeckMediaLineMarquee(titleEl, text, { dataKey: "deckLastTitle" });
  }

  function applyDeckMediaArtistMarquee(artistEl, text) {
    applyDeckMediaLineMarquee(artistEl, text, { dataKey: "deckLastArtist" });
  }

  function syncPlayerBarTitleMarquee(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return;
    syncDeckMediaInfo(bar);
  }

  function findAnyPlayerBarTitle(root) {
    if (!root) return null;
    return (
      qs(".content-info-wrapper .title", root) ||
      qs(".song-info .title", root) ||
      qs(".deck-bar-title-mirror", root) ||
      qs("yt-formatted-string.title", root) ||
      qs(".title", root)
    );
  }

  function findLeftPlayerBarTitle(left) {
    return findAnyPlayerBarTitle(left);
  }

  function readDeckBarDisplayTitle(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");

    const fromNative = readLivePlayerBarTitle(bar, { skipDeckMedia: true });
    if (fromNative) return fromNative;

    const fromMarquee = readMarqueeTitle(bar);
    if (fromMarquee) return fromMarquee;

    const titleSelectors = [
      ".middle-controls .title",
      ".middle-controls .song-info .title",
      ".left-controls .content-info-wrapper .title",
      ".left-controls .song-info .title",
    ];
    for (const sel of titleSelectors) {
      const el = bar ? qs(sel, bar) : null;
      if (!el || el.closest(".deck-media-title, .deck-title-marquee")) continue;
      const marqueeText = readMarqueeTitle(el);
      if (marqueeText) return marqueeText;
      const text = (el.textContent || "").trim();
      if (text) return text;
    }

    return readSongTitle() || "";
  }

  function readDeckBarDisplayArtist(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return "";

    const bylineSelectors = [
      ".middle-controls .byline",
      ".middle-controls .song-info .byline",
      ".left-controls .content-info-wrapper .byline",
      ".left-controls .song-info .byline",
    ];
    for (const sel of bylineSelectors) {
      const text = extractArtistFromByline(qs(sel, bar));
      if (text) return text;
    }

    return readSongArtist() || readQueueArtist() || "";
  }

  function relocatePlayerBarLikes(bar) {
    const block = qs(".deck-media-info", bar);
    const likes =
      qs(".middle-controls-buttons", bar) ||
      qs(".middle-controls .middle-controls-buttons", bar);
    if (!block || !likes) return;

    if (!block.contains(likes)) {
      likes.classList.add("deck-media-likes");
      block.appendChild(likes);
    }
  }

  function normalizeDeckMediaInfoOrder(block) {
    if (!block) return;
    const thumbWrap = qs(".deck-media-thumb", block);
    const textWrap = qs(".deck-media-text", block);
    if (!thumbWrap) return;

    if (block.firstElementChild !== thumbWrap) {
      block.insertBefore(thumbWrap, block.firstElementChild);
    }
    if (textWrap && thumbWrap.nextElementSibling !== textWrap) {
      block.insertBefore(textWrap, thumbWrap.nextElementSibling);
    }
  }

  function ensureDeckMediaInfo(bar) {
    const left = qs(".left-controls", bar);
    if (!left) return null;

    let block = qs(".deck-media-info", left);
    if (!block) {
      block = document.createElement("div");
      block.className = "deck-media-info";

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "deck-media-thumb";

      const textWrap = document.createElement("div");
      textWrap.className = "deck-media-text";

      const titleEl = document.createElement("div");
      titleEl.className = "deck-media-title";

      const artistEl = document.createElement("div");
      artistEl.className = "deck-media-artist";

      textWrap.append(titleEl, artistEl);
      block.append(thumbWrap, textWrap);

      const buttons = qs(".left-controls-buttons", left);
      if (buttons?.parentElement === left) {
        buttons.insertAdjacentElement("afterend", block);
      } else {
        left.appendChild(block);
      }
    }

    const thumbWrap = qs(".deck-media-thumb", block);
    const thumbSelectors =
      ".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer, yt-img-shadow.image, yt-img-shadow#thumbnail";
    qsa(thumbSelectors, bar).forEach((thumb) => {
      if (!thumbWrap || thumbWrap.contains(thumb) || !shouldRelocatePlayerBarThumb(thumb, bar)) return;
      thumbWrap.appendChild(thumb);
    });
    ensureDeckMediaThumbContent(bar, thumbWrap);

    let textWrap = qs(".deck-media-text", block);
    if (!textWrap) {
      textWrap = document.createElement("div");
      textWrap.className = "deck-media-text";
      if (thumbWrap) thumbWrap.insertAdjacentElement("afterend", textWrap);
      else block.appendChild(textWrap);
    }

    let titleEl = qs(".deck-media-title", block);
    if (!titleEl) {
      titleEl = document.createElement("div");
      titleEl.className = "deck-media-title";
      textWrap.appendChild(titleEl);
    } else if (!textWrap.contains(titleEl)) {
      textWrap.appendChild(titleEl);
    }

    let artistEl = qs(".deck-media-artist", block);
    if (!artistEl) {
      artistEl = document.createElement("div");
      artistEl.className = "deck-media-artist";
      textWrap.appendChild(artistEl);
    } else if (!textWrap.contains(artistEl)) {
      textWrap.appendChild(artistEl);
    }

    normalizeDeckMediaInfoOrder(block);
    relocatePlayerBarLikes(bar);

    return {
      block,
      titleEl,
      artistEl,
    };
  }

  function syncDeckMediaInfo(bar) {
    const ui = ensureDeckMediaInfo(bar);
    if (!ui?.titleEl || !ui?.artistEl) return;

    let title = readDeckBarDisplayTitle(bar);
    if (!title && ui.titleEl.dataset.deckLastTitle) {
      title = ui.titleEl.dataset.deckLastTitle;
    }

    let artist = readDeckBarDisplayArtist(bar) || readSongArtist() || "";
    if (!artist && ui.artistEl.dataset.deckLastArtist) {
      artist = ui.artistEl.dataset.deckLastArtist;
    }

    applyDeckMediaTitleMarquee(ui.titleEl, title);
    applyDeckMediaArtistMarquee(ui.artistEl, artist);
    scheduleDeckMediaMarqueeMeasure(bar);
    syncPlayerBarThumbnail();
  }

  function reorganizePlayerBarLeft(bar) {
    const left = qs(".left-controls", bar);
    if (!left) return null;

    qsa(".deck-bar-artist", left).forEach((el) => {
      if (!el.closest(".deck-bar-info, .content-info-wrapper, .song-info, .deck-bar-track")) {
        el.remove();
      }
    });

    let track = qs(".deck-bar-track", left);
    if (!track) {
      track = document.createElement("div");
      track.className = "deck-bar-track";
      const buttons = qs(".left-controls-buttons", left);
      if (buttons?.parentElement === left) {
        left.insertBefore(track, buttons.nextElementSibling);
      } else {
        left.prepend(track);
      }
    }

    const thumb = qs(".thumbnail-image-wrapper, .song-image, ytmusic-thumbnail-renderer", left);
    if (thumb && !track.contains(thumb)) {
      track.appendChild(thumb);
    }

    let stack =
      qs(".deck-bar-info", track) ||
      qs(".content-info-wrapper", track) ||
      qs(".song-info", track);

    const orphanStack = qs(".content-info-wrapper, .song-info, .deck-bar-info", left);
    if (orphanStack && !track.contains(orphanStack)) {
      if (!stack) stack = orphanStack;
      track.appendChild(orphanStack);
    }

    if (!stack) {
      stack = document.createElement("div");
      stack.className = "deck-bar-info";
      track.appendChild(stack);
    }

    qsa(".title, yt-formatted-string.title, .deck-bar-title-mirror", left).forEach((titleEl) => {
      if (titleEl.closest(".left-controls-buttons, .middle-controls, .deck-title-marquee")) return;
      if (stack.contains(titleEl)) return;
      if (!left.contains(titleEl)) return;
      stack.appendChild(titleEl);
    });

    const bylineWrap = qs(".byline-wrapper", left);
    if (bylineWrap && !stack.contains(bylineWrap) && left.contains(bylineWrap)) {
      stack.appendChild(bylineWrap);
    }

    const buttons = qs(".left-controls-buttons", left);
    if (buttons?.parentElement === left && track.parentElement === left) {
      if (track.previousElementSibling !== buttons) {
        left.insertBefore(track, buttons.nextElementSibling);
      }
    }

    return { track, stack };
  }

  function ensurePlayerBarTextColumn(bar) {
    const layout = reorganizePlayerBarLeft(bar);
    return layout?.stack || null;
  }

  function ensureLeftTitleMirror(bar, liveTitle) {
    reorganizePlayerBarLeft(bar);
    const left = qs(".left-controls", bar);
    if (!left) return null;

    const stack = ensurePlayerBarTextColumn(bar);
    const nativeLeft = findLeftPlayerBarTitle(left);
    if (nativeLeft && !nativeLeft.classList.contains("deck-bar-title-mirror") && stack?.contains(nativeLeft)) {
      qs(".deck-bar-title-mirror", stack)?.remove();
      return nativeLeft;
    }
    if (!stack) return null;

    let mirror = qs(".deck-bar-title-mirror", stack);
    if (!mirror) {
      mirror = document.createElement("div");
      mirror.className = "title deck-bar-title-mirror";
      const artist = qs(".deck-bar-artist", stack);
      stack.insertBefore(mirror, artist || stack.firstChild);
    }

    if (!liveTitle) {
      mirror.textContent = "";
      mirror.classList.remove("deck-has-marquee");
      qs(".deck-title-marquee", mirror)?.remove();
      return mirror;
    }

    let wrap = qs(".deck-title-marquee", mirror);
    if (!wrap) {
      mirror.textContent = "";
      wrap = document.createElement("div");
      wrap.className = "deck-title-marquee";
      const inner = document.createElement("div");
      inner.className = "deck-title-marquee-inner";
      const primary = document.createElement("span");
      primary.className = "deck-title-marquee-text";
      inner.appendChild(primary);
      wrap.appendChild(inner);
      mirror.appendChild(wrap);
    }

    wrap.dataset.deckOriginalText = liveTitle;
    qsa(".deck-title-marquee-text", wrap).forEach((node) => {
      node.textContent = liveTitle;
    });
    mirror.classList.add("deck-has-marquee");
    return mirror;
  }

  function ensurePlayerBarArtist(bar) {
    const layout = reorganizePlayerBarLeft(bar);
    if (!layout) return null;

    const { stack } = layout;
    const left = qs(".left-controls", bar);

    let artistEl = qs(".deck-bar-artist", stack);
    if (!artistEl) {
      artistEl = document.createElement("div");
      artistEl.className = "deck-bar-artist";
    }

    const titleEl = (() => {
      const native = findLeftPlayerBarTitle(left);
      if (native && !native.classList.contains("deck-bar-title-mirror") && stack.contains(native)) {
        return native;
      }
      return qs(".deck-bar-title-mirror", stack) || findAnyPlayerBarTitle(stack);
    })();

    if (titleEl && stack.contains(titleEl)) {
      if (artistEl.parentElement !== stack) {
        stack.appendChild(artistEl);
      }
      if (artistEl.previousElementSibling !== titleEl) {
        titleEl.insertAdjacentElement("afterend", artistEl);
      }
    } else if (!stack.contains(artistEl)) {
      stack.appendChild(artistEl);
    }

    return artistEl;
  }

  function syncPlayerBarArtist(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return;
    syncDeckMediaInfo(bar);
  }

  function getPlayerBarTitleElements(bar) {
    const selectors = [
      ".left-controls .content-info-wrapper .title",
      ".left-controls .song-info .title",
      ".left-controls > .title",
      ".left-controls > yt-formatted-string.title",
      ".middle-controls .content-info-wrapper .title",
      ".middle-controls .song-info .title",
      ".middle-controls > .title",
      ".middle-controls > yt-formatted-string.title",
    ];
    const seen = new Set();
    const result = [];
    selectors.forEach((sel) => {
      qsa(sel, bar).forEach((el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        result.push(el);
      });
    });
    return result;
  }

  function setupPlayerBarTitleMarquee(bar) {
    syncPlayerBarTitleMarquee(bar);
  }

  function stripLegacyNativeTitleMarquees(bar) {
    if (!bar) return;
    qsa(".deck-title-marquee", bar).forEach((wrap) => {
      if (wrap.closest(".deck-media-title")) return;
      const host = wrap.parentElement;
      wrap.remove();
      host?.classList.remove("deck-has-marquee", "deck-hide-duplicate-title");
    });
  }

  function fixPlayerBarLayout() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return;

    stripLegacyNativeTitleMarquees(bar);

    qsa(".left-controls, .content-info-wrapper, .song-info, .deck-title-marquee", bar).forEach((el) => {
      el.style.removeProperty("width");
      el.style.removeProperty("max-width");
      el.style.removeProperty("flex");
      el.style.removeProperty("flex-shrink");
    });

    qsa(".left-controls .byline-wrapper, .left-controls .byline", bar).forEach((el) => {
      el.style.removeProperty("display");
      el.style.removeProperty("visibility");
    });

    setupPlayerBarTitleMarquee(bar);
    syncDeckMediaInfo(bar);
  }

  function fixPlayerBar() {
    const bar = qs("ytmusic-player-bar");
    if (!bar) return;
    bar.style.visibility = "visible";
    bar.style.opacity = "1";
    bar.style.transform = "none";
    bindPlayerBarThumbnailEvents();
    fixPlayerBarLayout();
    fixPlayerBarProgress();
    fixPlayerBarVolume();
    ensurePlayerBarToggle(bar);
    syncDeckMediaInfo(bar);
    requestAnimationFrame(() => syncDeckMediaInfo(bar));
  }

  function applyProgressKnobStyle(knob) {
    if (!knob) return;
    const knobPx = deckCssNum("--deck-player-progress-knob", 26);
    const knobHalf = knobPx / 2;
    const trackHalf = 1.5;
    knob.style.setProperty("width", `${knobPx}px`, "important");
    knob.style.setProperty("height", `${knobPx}px`, "important");
    knob.style.setProperty("top", `${trackHalf}px`, "important");
    knob.style.setProperty("margin-top", `-${knobHalf}px`, "important");
    knob.style.setProperty("margin-left", `-${knobHalf}px`, "important");
  }

  function applyVolumeKnobStyle(slider) {
    const knob = qs("#sliderKnob, .slider-knob", slider);
    const container = qs("#sliderKnobContainer", slider);
    if (!knob || !container) return;
    const knobPx = deckCssNum("--deck-volume-knob", 24);
    const half = knobPx / 2;
    knob.style.setProperty("width", `${knobPx}px`, "important");
    knob.style.setProperty("height", `${knobPx}px`, "important");
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

  function ensurePlayerBarToggle(bar) {
    if (!bar) bar = qs("ytmusic-player-bar");
    if (!bar) return;

    const right = qs(".right-controls", bar);
    const buttons = qs(".right-controls-buttons", right);
    const toggle = qs(".toggle-player-page-button", bar);
    if (!right || !toggle) return;

    if (toggle.parentElement !== right) {
      right.appendChild(toggle);
    } else if (buttons?.parentElement === right) {
      right.appendChild(toggle);
    }

    [
      "display",
      "visibility",
      "width",
      "min-width",
      "max-width",
      "height",
      "min-height",
      "max-height",
      "opacity",
      "pointer-events",
      "margin",
      "padding",
      "transform",
      "top",
      "left",
    ].forEach((prop) => toggle.style.removeProperty(prop));

    qsa("button, yt-icon-button, tp-yt-paper-icon-button", toggle).forEach((btn) => {
      ["width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "padding", "transform", "top", "left"].forEach(
        (prop) => btn.style.removeProperty(prop)
      );
    });
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
    bar.style.overflowX = "clip";
    bar.style.overflowY = "visible";
    const knobPx = deckCssNum("--deck-player-progress-knob", 26);
    bar.style.paddingTop = active ? `${Math.ceil(knobPx / 2 + 6)}px` : "0";

    if (!active) {
      if (progress) progress.style.display = "none";
      const wrap = qs(".progress-bar-wrapper", bar);
      if (wrap) wrap.style.display = "none";
      return;
    }

    if (progress) {
      progress.style.display = "block";
      const knobHalf = knobPx / 2;
      const leftInset = deckCssNum("--deck-player-progress-inset-left", 42);
      const rightInset = deckCssNum("--deck-player-progress-inset-right", 42);
      const trackWidth = Math.max(0, bar.offsetWidth - leftInset - rightInset);
      Object.assign(progress.style, {
        position: "absolute",
        top: "0",
        left: `${leftInset}px`,
        right: "auto",
        width: `${trackWidth}px`,
        height: `${knobPx}px`,
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
          height: `${knobPx}px`,
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

  function applyVolumeLevel(volume01) {
    const level = Math.min(1, Math.max(0, Number(volume01)));
    if (!Number.isFinite(level)) return;

    const video = getVideo();
    if (video) video.volume = level;

    const bar = qs("ytmusic-player-bar");
    if (bar && typeof bar.setVolume === "function") {
      try {
        bar.setVolume(level * 100);
      } catch (_) {}
    }

    const slider = qs(
      "ytmusic-player-bar #volume-slider, ytmusic-player-bar tp-yt-paper-slider.volume-slider"
    );
    if (slider) {
      const pct = Math.round(level * 100);
      if ("value" in slider) slider.value = pct;
      if ("immediateValue" in slider) slider.immediateValue = pct;
      slider.dispatchEvent(new Event("immediate-value-change", { bubbles: true, composed: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }

    fixPlayerBarVolume();
    updateDeckUi();
    reportState();
  }

  function scheduleStateReports() {
    [150, 450, 1000].forEach((ms) => {
      setTimeout(() => {
        reportState();
        updateDeckUi();
      }, ms);
    });
  }

  function scheduleLayout() {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(applyDeckLayout, 600);
  }

  function handleCommand(command, data) {
    const video = getVideo();
    switch (command) {
      case "play":
        if (video) {
          try { video.play(); } catch (_) {}
        } else {
          click("ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button");
        }
        break;
      case "pause":
        if (video) {
          try { video.pause(); } catch (_) {}
        } else {
          click("ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button");
        }
        break;
      case "playPause":
        if (video) {
          try {
            if (video.paused) video.play();
            else video.pause();
          } catch (_) {
            click("ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button");
          }
        } else {
          click("ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button");
        }
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
        if (video) {
          video.currentTime = Number(data.positionUs || 0) / 1_000_000;
          reportState();
        }
        break;
      case "setVolume":
        applyVolumeLevel(Number(data.volume));
        break;
      case "seekTo":
        if (video && Number.isFinite(Number(data.seconds))) {
          video.currentTime = Math.max(0, Number(data.seconds));
          reportState();
        }
        break;
      case "toggleMute":
        if (video) video.muted = !video.muted;
        updateDeckUi();
        break;
      case "setShuffle":
        ensureShuffle(typeof data?.shuffle === "boolean" ? data.shuffle : undefined);
        break;
      case "setLoop":
        if (data?.status === "None" || data?.status === "Playlist" || data?.status === "Track") {
          ensureRepeat(data.status);
        } else {
          clickRepeat(Number(data?.iteration) || 1);
        }
        break;
      case "queueIndex":
        if (Number.isFinite(Number(data.index))) queueJumpToIndex(Number(data.index));
        break;
      case "queueRemove":
        if (Number.isFinite(Number(data.index))) queueRemoveAt(Number(data.index));
        break;
      case "queueClear":
        queueClearAll();
        break;
      case "activate":
        deckActivate();
        break;
      case "back":
        // Qt Escape / comando "back": mismo criterio que Escape JS (no menú sistema).
        deckBack({ fromEscape: true });
        break;
      case "refreshQueue":
        primeQueueForApi();
        break;
      case "resetTouch":
        resetTouchState(data?.reason || "command");
        break;
      default:
        break;
    }
    setTimeout(() => {
      scheduleLayout();
      scheduleStateReports();
    }, 0);
  }

  function bindVideoEvents() {
    const video = getVideo();
    if (!video || video.dataset.deckBound) return;
    video.dataset.deckBound = "1";
    const onPlaybackChange = () => {
      scheduleLayout();
      reportState();
    };
    video.addEventListener("play", onPlaybackChange);
    video.addEventListener("pause", onPlaybackChange);
    video.addEventListener("loadedmetadata", scheduleLayout);
    video.addEventListener("seeked", () => {
      reportState();
    });
    video.addEventListener("timeupdate", updateDeckUi);
    video.addEventListener("volumechange", () => {
      updateDeckUi();
      reportState();
    });
  }

  function observeDom() {
    if (domObserver) return;
    domObserver = new MutationObserver(() => {
      if (observerTimer) clearTimeout(observerTimer);
      observerTimer = setTimeout(() => {
        scheduleLayout();
        bindVideoEvents();
        if (isPlayerPageOpen() || qs("#side-panel")) {
          ensureQueueItemMenus();
        }
        if (activeQueueMenuProxy) repositionQueuePopups(activeQueueMenuProxy);
      }, 1200);
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
    bindPlayerModeObservers();
    observeDom();

    if (!pollTimer) {
      pollTimer = setInterval(() => {
        pollTick += 1;
        updateDeckUi();
        reportState();
        bindVideoEvents();
        fixPlayerBarProgress();
        if (pollTick % POLL_HEAVY_EVERY !== 0) return;
        fixPlayerBarVolume();
        fixLibraryTabs();
        fixCarouselText();
        paintDeckAccentSurfaces();
        paintDeckAccentTabs();
        ensureAccountMenuAccess();
        if (isPlayerPageOpen() || qs("#side-panel")) {
          ensureQueueItemMenus();
        }
        bindCarouselNav();
        if (activeQueueMenuProxy) repositionQueuePopups(activeQueueMenuProxy);
      }, POLL_MS);
    }

    if (!layoutInterval) {
      layoutInterval = setInterval(scheduleLayout, 10000);
    }

    window.addEventListener("resize", () => {
      applyViewportMetrics();
      scheduleLayout();
    });
  }

  function debugGuideScroll() {
    ensureGuideScrollLayout();
    const cc = qs("tp-yt-app-drawer#guide #contentContainer");
    const scroller = getGuideScroller();
    const snap = (el) =>
      el
        ? {
            tag: el.tagName?.toLowerCase?.() || null,
            cls: el.className || null,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            scrollTop: el.scrollTop,
            overflowY: getComputedStyle(el).overflowY,
            canScroll: el.scrollHeight > el.clientHeight + 2,
          }
        : null;
    return {
      entries: qsa("ytmusic-guide-entry-renderer").length,
      contentContainer: snap(cc),
      scroller: snap(scroller),
    };
  }

  return {
    start,
    handleCommand,
    applyDeckLayout,
    scheduleLayout,
    collectState,
    collectQueue,
    resetTouchState,
    debugGuideScroll,
    get ready() {
      return deckUiReady;
    },
  };
})();
