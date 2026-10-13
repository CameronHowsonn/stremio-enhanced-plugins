/**
 * @name Watch Stats
 * @description Adds a Stats button to the Board. Lists every film and show you have watched with watch counts, time watched and the date last watched; shows open like an accordion to list every episode. Reads Stremio's own library and records episode detail as you watch. No network calls.
 * @version 1.1.0
 */

(function () {
  'use strict';

  // If an earlier copy is still running (plugin toggled off and on without a reload), remove it first.
  if (typeof window.__watchStatsTeardown === 'function') {
    try {
      window.__watchStatsTeardown();
    } catch (_) {
      // nothing to clean up
    }
  }

  // ------------------------------------------------------------------ constants

  const NS = 'wst';
  const BUTTON_ID = `${NS}-button`;
  const OVERLAY_ID = `${NS}-overlay`;
  const STYLE_ID = `${NS}-styles`;
  const HISTORY_KEY = 'history'; // the plugin's settings file (watchstats.plugin.json)
  const BACKUP_KEY = 'watchstats.history'; // a second copy, in Stremio's own localStorage
  const LIBRARY_KEYS = ['library_recent', 'library']; // Stremio keeps the 200 newest items in one and the rest in the other
  const WATCHED_COEF = 0.7; // Stremio itself counts something as watched after 70% of its length
  const FINISH_COEF = 0.5; // reaching the very end counts once at least half was really watched
  const STARTED_MIN_MS = 60 * 1000; // under a minute is a stray click, not watching
  const MAX_STEP_S = 3; // a bigger jump in playback position than this is a seek, not watching
  const SAVE_EVERY_MS = 60 * 1000; // while playing; it also saves on pause, on finishing and on leaving the player
  const TICK_MS = 1000;
  const FALLBACK_AFTER_TICKS = 4; // no Board heading after this many seconds: float the button in the corner instead
  const META_ATTEMPTS = 10; // tries to read the episode title from Stremio after a video starts
  const DASH = '-';
  const TIMES = String.fromCharCode(0xd7);
  const SKIPPED_TYPES = ['tv', 'channel', 'other'];

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const GRAPH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M21 20H3"></path></svg>';
  const CHEVRON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>';
  const CLOSE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

  const SORTS = [
    { value: 'recent', label: 'Last watched' },
    { value: 'name', label: 'A to Z' },
    { value: 'time', label: 'Most time' },
    { value: 'count', label: 'Most watched' },
  ];

  // Inside the host this is the per-plugin scoped API; fall back to the global one if it is missing.
  const api =
    typeof StremioEnhancedAPI !== 'undefined'
      ? StremioEnhancedAPI
      : window.StremioEnhancedAPI;

  // ------------------------------------------------------------------ state

  let history = null; // { v, since, entries } once loaded from the plugin's settings file
  let dirty = false; // history has changes that are not saved yet
  let lastSaveAt = Date.now();
  let session = null; // the video being tracked right now: { key, ident, lastTime, restartChecked, meta, metaTries }
  let button = null;
  let buttonAnchor = null; // the heading the button sits in, or null while it floats in the corner
  let noAnchorTicks = 0; // seconds spent on the Board without finding a heading
  let overlay = null; // the open stats view: { root, list, ... }
  let view = null; // what the open stats view is showing: { tab, query, sort, finishedOnly, open }
  let model = null; // films and shows prepared when the view was opened

  // ------------------------------------------------------------------ helpers

  function log(level, message) {
    try {
      api.logger[level](message);
    } catch (_) {
      console[level === 'info' ? 'log' : level]('[Watch Stats]', message);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function formatTime(ms) {
    if (!(ms > 0)) {
      return DASH;
    }
    if (ms < 60000) {
      return `${Math.max(1, Math.round(ms / 1000))}s`;
    }
    const totalMinutes = Math.round(ms / 60000);
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }
    return `${Math.floor(totalMinutes / 60).toLocaleString()}h ${pad2(totalMinutes % 60)}m`;
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  function formatDate(ms) {
    return ms > 0 ? dateFormat.format(new Date(ms)) : DASH;
  }

  function episodeLabel(entry) {
    if (entry.season > 0) {
      return `S${pad2(entry.season)}E${pad2(entry.episode)}`;
    }
    return entry.episode !== null && entry.episode !== undefined
      ? `E${pad2(entry.episode)}`
      : entry.videoId;
  }

  // ------------------------------------------------------------------ saved history (episode detail recorded by this plugin)

  function newHistory() {
    return { v: 1, since: Date.now(), entries: {} };
  }

  function isHistory(value) {
    return (
      !!value &&
      typeof value === 'object' &&
      !!value.entries &&
      typeof value.entries === 'object'
    );
  }

  function readBackup() {
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(BACKUP_KEY) || 'null',
      );
      return isHistory(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeBackup() {
    try {
      window.localStorage.setItem(BACKUP_KEY, JSON.stringify(history));
    } catch (_) {
      // storage is full or blocked; the file copy still works
    }
  }

  // Both copies are written together, so they normally match. If one is missing, damaged or behind (say the app
  // crashed between the two writes), keep the newer one and add any episodes only the other copy has.
  function mergeHistories(file, backup) {
    if (!file || !backup) {
      return file || backup;
    }
    const newer = (file.savedAt || 0) >= (backup.savedAt || 0) ? file : backup;
    const older = newer === file ? backup : file;
    Object.keys(older.entries).forEach((key) => {
      const mine = newer.entries[key];
      if (!mine || (older.entries[key].ms || 0) > (mine.ms || 0)) {
        newer.entries[key] = older.entries[key];
      }
    });
    newer.since = Math.min(
      file.since || Date.now(),
      backup.since || Date.now(),
    );
    return newer;
  }

  async function loadHistory() {
    let saved = null;
    try {
      saved = await api.getSetting(HISTORY_KEY);
    } catch (_) {
      // nothing saved yet
    }
    const file = isHistory(saved) ? saved : null;
    const backup = readBackup();
    const inSync = !!file && !!backup && file.savedAt === backup.savedAt;
    history = mergeHistories(file, backup) || newHistory();
    log(
      'info',
      `History loaded (${Object.keys(history.entries).length} tracked, file ${file ? 'ok' : 'missing'}, backup ${backup ? 'ok' : 'missing'})`,
    );
    if (!inSync) {
      dirty = true;
      saveHistory(); // writes both copies, which repairs whichever one was missing
    }
  }

  function saveHistory() {
    if (!history || !dirty) {
      return;
    }
    dirty = false;
    lastSaveAt = Date.now();
    history.savedAt = lastSaveAt;
    writeBackup();
    Promise.resolve()
      .then(() => api.saveSetting(HISTORY_KEY, history))
      .catch((err) => {
        dirty = true;
        log('warn', `Could not save history: ${(err && err.message) || err}`);
      });
  }

  // ------------------------------------------------------------------ recording what you watch

  // The player route ends with: type / id / video id (the stream and addon URLs come before them).
  function identify(hash) {
    const parts = hash.split('?')[0].split('/').filter(Boolean);
    const at = parts.indexOf('player');
    if (at < 0 || parts.length - at - 1 < 6) {
      return null;
    }
    const [type, id, videoId] = parts.slice(-3).map(safeDecode);
    if (!type || !id || !videoId || SKIPPED_TYPES.includes(type)) {
      return null;
    }
    let season = null;
    let episode = null;
    if (type !== 'movie') {
      const numbers = (videoId.startsWith(id) ? videoId.slice(id.length) : '')
        .split(':')
        .filter(Boolean)
        .map(Number);
      if (numbers.length >= 2 && numbers.every(Number.isFinite)) {
        season = numbers[numbers.length - 2];
        episode = numbers[numbers.length - 1];
      } else if (numbers.length === 1 && Number.isFinite(numbers[0])) {
        season = 0;
        episode = numbers[0];
      }
    }
    return { key: `${id}|${videoId}`, id, videoId, type, season, episode };
  }

  function entryFor(ident) {
    let entry = history.entries[ident.key];
    if (!entry) {
      entry = {
        id: ident.id,
        videoId: ident.videoId,
        type: ident.type,
        season: ident.season,
        episode: ident.episode,
        plays: 0,
        ms: 0,
        partialMs: 0,
        credited: false,
        frac: 0,
        last: 0,
      };
      history.entries[ident.key] = entry;
    }
    return entry;
  }

  function creditPlay(entry) {
    entry.plays += 1;
    entry.credited = true;
    entry.partialMs = 0;
  }

  // A viewing is over (it ended, or you started it again from the beginning).
  function finishViewing(entry, durationMs) {
    if (
      !entry.credited &&
      durationMs > 0 &&
      entry.partialMs >= FINISH_COEF * durationMs
    ) {
      creditPlay(entry);
    }
    entry.credited = false;
    entry.partialMs = 0;
  }

  function addWatched(entry, deltaMs, durationMs) {
    entry.ms += deltaMs;
    entry.last = Date.now();
    if (entry.credited || !(durationMs > 0)) {
      return;
    }
    entry.partialMs += deltaMs;
    if (entry.partialMs >= WATCHED_COEF * durationMs) {
      creditPlay(entry);
    }
  }

  // Playback position moved forward normally while playing: that is time watched.
  function onTimeUpdate(e) {
    const video = e.target;
    if (!history || !session || !video || video.tagName !== 'VIDEO') {
      return;
    }
    const time = video.currentTime;
    const delta = time - session.lastTime;
    session.lastTime = time;
    if (video.paused) {
      saveHistory(); // you paused: a good moment to write to disk
      return;
    }
    if (
      video.seeking ||
      !(delta > 0) ||
      delta > MAX_STEP_S * Math.max(1, video.playbackRate)
    ) {
      return;
    }
    const durationMs = Number.isFinite(video.duration)
      ? video.duration * 1000
      : 0;
    const entry = entryFor(session.ident);
    if (!session.restartChecked && durationMs > 0) {
      session.restartChecked = true;
      if (time * 1000 < 0.1 * durationMs && entry.frac >= 0.3) {
        finishViewing(entry, durationMs); // starting again from the beginning
      }
    }
    if (session.meta && !entry.name) {
      entry.name = session.meta.name;
      entry.title = session.meta.title;
    }
    addWatched(entry, delta * 1000, durationMs);
    entry.frac =
      durationMs > 0 ? Math.min(1, (time * 1000) / durationMs) : entry.frac;
    dirty = true;
  }

  function onVideoEnded(e) {
    if (!history || !session || !e.target || e.target.tagName !== 'VIDEO') {
      return;
    }
    const entry = history.entries[session.ident.key];
    if (entry) {
      const durationMs = Number.isFinite(e.target.duration)
        ? e.target.duration * 1000
        : 0;
      finishViewing(entry, durationMs);
      entry.frac = 0;
      dirty = true;
      saveHistory();
    }
  }

  // Stremio's player state knows the show name and episode title; the route only has ids. Best effort.
  async function readPlayerMeta(ident) {
    try {
      const core =
        window.services &&
        window.services.core &&
        window.services.core.transport;
      if (!core || typeof core.getState !== 'function') {
        return null;
      }
      const state = await core.getState('player');
      const content = state && state.metaItem && state.metaItem.content;
      if (!content || String(content.id) !== ident.id) {
        return null;
      }
      const video = (content.videos || []).find(
        (v) => String(v.id) === ident.videoId,
      );
      return {
        name: content.name ? String(content.name) : '',
        title: video ? String(video.title || video.name || '') : '',
      };
    } catch (_) {
      return null;
    }
  }

  function startSession(ident) {
    session = {
      key: ident.key,
      ident,
      lastTime: 0,
      restartChecked: false,
      meta: null,
      metaTries: 0,
    };
    const video = document.querySelector('video');
    if (video) {
      session.lastTime = video.currentTime;
    }
  }

  function endSession() {
    if (!session) {
      return;
    }
    session = null;
    saveHistory();
  }

  function updateSession(video) {
    const ident = video ? identify(window.location.hash) : null;
    if (!ident) {
      endSession();
      return;
    }
    if (!session || session.key !== ident.key) {
      endSession();
      startSession(ident);
    }
    if (!session.meta && session.metaTries < META_ATTEMPTS) {
      session.metaTries += 1;
      const current = session;
      readPlayerMeta(ident).then((meta) => {
        if (meta && session === current) {
          session.meta = meta;
        }
      });
    }
  }

  // ------------------------------------------------------------------ reading Stremio's library

  function readLibraryItems() {
    const merged = new Map();
    LIBRARY_KEYS.forEach((key) => {
      let parsed = null;
      try {
        parsed = JSON.parse(window.localStorage.getItem(key) || 'null');
      } catch (_) {
        parsed = null;
      }
      const items = parsed && parsed.items;
      if (!items || typeof items !== 'object') {
        return;
      }
      Object.values(items).forEach((item) => {
        if (!item || !item._id) {
          return;
        }
        const existing = merged.get(item._id);
        if (
          !existing ||
          (Date.parse(item._mtime) || 0) > (Date.parse(existing._mtime) || 0)
        ) {
          merged.set(item._id, item);
        }
      });
    });
    return [...merged.values()];
  }

  function libraryStats(item) {
    const state = item.state || {};
    const timesWatched = Number(state.timesWatched) || 0;
    const finished =
      timesWatched > 0 || (Number(state.flaggedWatched) || 0) > 0;
    return {
      ms:
        (Number(state.overallTimeWatched) || 0) +
        (Number(state.timeWatched) || 0),
      plays: Math.max(timesWatched, finished ? 1 : 0),
      finished,
      last: Date.parse(state.lastWatched) || 0,
    };
  }

  // The list of what you have watched comes from Stremio's library. Times and counts come from what this plugin has
  // measured itself. Stremio's own totals are kept alongside (lib*) because they can be wildly inflated, so they
  // are only shown when asked for.
  function buildModel() {
    const films = new Map();
    const shows = new Map();

    readLibraryItems().forEach((item) => {
      const stats = libraryStats(item);
      if (
        SKIPPED_TYPES.includes(item.type) ||
        !(stats.finished || stats.ms >= STARTED_MIN_MS)
      ) {
        return;
      }
      const name = item.name ? String(item.name) : String(item._id);
      if (item.type === 'movie') {
        films.set(item._id, {
          id: item._id,
          name,
          libPlays: stats.plays,
          libMs: stats.ms,
          libLast: stats.last,
          libFinished: stats.finished,
          plays: 0,
          ms: 0,
          last: 0,
        });
      } else {
        shows.set(item._id, {
          id: item._id,
          name,
          libMs: stats.ms,
          libLast: stats.last,
          libPlays: stats.plays,
          episodes: [],
        });
      }
    });

    Object.values(history ? history.entries : {}).forEach((entry) => {
      if (!(entry.ms > 0 || entry.plays > 0)) {
        return;
      }
      if (entry.type === 'movie') {
        const film = films.get(entry.id) || {
          id: entry.id,
          name: entry.name || entry.id,
          libPlays: 0,
          libMs: 0,
          libLast: 0,
          libFinished: false,
          plays: 0,
          ms: 0,
          last: 0,
        };
        film.plays += entry.plays;
        film.ms += entry.ms;
        film.last = Math.max(film.last, entry.last || 0);
        films.set(entry.id, film);
        return;
      }
      const show = shows.get(entry.id) || {
        id: entry.id,
        name: entry.name || entry.id,
        libMs: 0,
        libLast: 0,
        libPlays: 0,
        episodes: [],
      };
      show.episodes.push(entry);
      shows.set(entry.id, show);
    });

    const showList = [...shows.values()]
      .map((show) => {
        show.episodes.sort(
          (a, b) => a.season - b.season || a.episode - b.episode,
        );
        show.ms = show.episodes.reduce((sum, e) => sum + e.ms, 0);
        show.plays = show.episodes.reduce((sum, e) => sum + e.plays, 0);
        show.last = Math.max(
          show.libLast,
          show.episodes.reduce((latest, e) => Math.max(latest, e.last || 0), 0),
        );
        return show;
      })
      .filter(
        (show) =>
          show.libMs >= STARTED_MIN_MS ||
          show.episodes.length > 0 ||
          show.libPlays > 0,
      );

    const filmList = [...films.values()];
    filmList.forEach((film) => {
      film.last = Math.max(film.last, film.libLast);
    });
    const episodeCount = showList.reduce(
      (sum, show) => sum + show.episodes.length,
      0,
    );
    return { films: filmList, shows: showList, episodeCount };
  }

  // ------------------------------------------------------------------ styles

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
            .${NS}-button { display: inline-flex; align-items: center; gap: 6px; margin-left: 14px; padding: 5px 11px 5px 9px; vertical-align: middle;
                border: none; border-radius: 99px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8);
                font: 600 12px/1 ${FONT}; letter-spacing: 0; text-transform: none; white-space: nowrap; cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease; }
            .${NS}-button:hover { background: rgba(255,255,255,0.16); color: #fff; }
            .${NS}-button svg { width: 14px; height: 14px; }
            .${NS}-button.${NS}-floating { position: fixed; right: 24px; bottom: 24px; z-index: 99990; margin: 0; padding: 10px 16px 10px 13px;
                border: 1px solid rgba(255,255,255,0.12); background: rgba(20,20,25,0.82); color: #fff; font-size: 13px;
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 10px 30px -10px rgba(0,0,0,0.7); }
            .${NS}-button.${NS}-floating:hover { background: rgba(40,40,52,0.92); }
            .${NS}-button.${NS}-floating svg { width: 16px; height: 16px; }

            .${NS}-overlay { position: fixed; inset: 0; z-index: 999990; display: flex; align-items: center; justify-content: center;
                background: rgba(0,0,0,0.55); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                font-family: ${FONT}; color: #fff; animation: ${NS}-fade 0.18s ease; }
            @keyframes ${NS}-fade { from { opacity: 0; } to { opacity: 1; } }
            .${NS}-panel { width: min(1280px, 96vw); height: min(92vh, 960px); display: flex; flex-direction: column; overflow: hidden;
                border-radius: 18px; background: rgba(20,20,25,0.97); border: 1px solid rgba(255,255,255,0.08);
                box-shadow: 0 25px 60px -12px rgba(0,0,0,0.8); color-scheme: dark; }
            /* The title row, controls, column titles and footnote never squash; only the list gives way. */
            .${NS}-panel > * { flex: 0 0 auto; }
            .${NS}-panel > .${NS}-list { flex: 1 1 0; min-height: 0; }
            .${NS}-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 20px; padding: 14px 20px 4px; }
            .${NS}-title { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.3px; white-space: nowrap; }
            .${NS}-close { flex-shrink: 0; width: 32px; height: 32px; display: grid; place-items: center; border: none; border-radius: 9px;
                background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; }
            .${NS}-close:hover { background: rgba(255,255,255,0.16); }
            .${NS}-close svg { width: 16px; height: 16px; }

            .${NS}-tiles { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
            .${NS}-tile { min-width: 104px; padding: 6px 12px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.06); }
            .${NS}-tile-value { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; }
            .${NS}-tile-label { margin-top: 1px; font-size: 10.5px; color: rgba(255,255,255,0.5); white-space: nowrap; }

            .${NS}-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 8px 20px; }
            .${NS}-tabs { display: flex; gap: 6px; }
            .${NS}-tab { border: none; border-radius: 99px; padding: 7px 13px; font: 600 12.5px/1 ${FONT}; color: #fff; cursor: pointer;
                background: rgba(255,255,255,0.08); }
            .${NS}-tab:hover { background: rgba(255,255,255,0.14); }
            .${NS}-tab[aria-selected="true"] { background: linear-gradient(135deg, #6366f1, #a855f7); }
            .${NS}-search { flex: 1 1 180px; min-width: 140px; box-sizing: border-box; padding: 7px 11px; border-radius: 9px; outline: none;
                border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #fff; font: 500 13px ${FONT}; }
            .${NS}-search:focus { border-color: rgba(168,85,247,0.7); }
            .${NS}-select { padding: 7px 9px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.12); outline: none;
                background: rgba(255,255,255,0.06); color: #fff; font: 500 13px ${FONT}; cursor: pointer; }
            .${NS}-check { display: flex; align-items: center; gap: 7px; font-size: 13px; color: rgba(255,255,255,0.8); cursor: pointer; user-select: none; }
            .${NS}-check input { width: 16px; height: 16px; accent-color: #a855f7; cursor: pointer; }

            .${NS}-cols, .${NS}-row { display: grid; grid-template-columns: minmax(0, 1fr) 92px 112px 120px; gap: 14px; align-items: center; }
            .${NS}-cols { padding: 6px 20px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
                color: rgba(255,255,255,0.4); border-top: 1px solid rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.08); }
            .${NS}-list { flex: 1 1 auto; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent; }
            .${NS}-row { padding: 8px 20px; font-size: 13px; font-variant-numeric: tabular-nums; border-bottom: 1px solid rgba(255,255,255,0.04); }
            .${NS}-row:hover { background: rgba(255,255,255,0.03); }
            .${NS}-name { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .${NS}-meta { margin-top: 2px; font-size: 11.5px; font-weight: 500; color: rgba(255,255,255,0.45); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .${NS}-num { color: rgba(255,255,255,0.85); }
            .${NS}-dim { color: rgba(255,255,255,0.4); }
            .${NS}-started { color: rgba(255,255,255,0.5); font-size: 12px; }

            .${NS}-show { width: 100%; text-align: left; border: none; background: none; color: inherit; font: inherit; cursor: pointer; }
            .${NS}-show .${NS}-lead { display: flex; align-items: center; gap: 12px; min-width: 0; }
            .${NS}-chev { flex-shrink: 0; width: 18px; height: 18px; color: rgba(255,255,255,0.5); transition: transform 0.18s ease; }
            .${NS}-chev svg { width: 18px; height: 18px; display: block; }
            .${NS}-show[aria-expanded="true"] .${NS}-chev { transform: rotate(90deg); color: #fff; }
            .${NS}-show[aria-expanded="true"] { background: rgba(255,255,255,0.04); }
            .${NS}-episodes { background: rgba(0,0,0,0.18); }
            .${NS}-ep { padding-top: 5px; padding-bottom: 5px; font-size: 12.5px; }
            .${NS}-ep .${NS}-lead { padding-left: 30px; }
            .${NS}-code { margin-right: 8px; font-weight: 700; color: #c4b5fd; }
            .${NS}-empty { padding: 40px 24px; text-align: center; color: rgba(255,255,255,0.45); font-size: 14px; }
            .${NS}-episodes .${NS}-empty { padding: 14px 24px; font-size: 12.5px; }
            .${NS}-foot { padding: 8px 20px 10px; font-size: 11px; color: rgba(255,255,255,0.4); border-top: 1px solid rgba(255,255,255,0.08);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

            @media (max-height: 520px) {
                .${NS}-panel { overflow-y: auto; }
                .${NS}-panel > .${NS}-list { flex: 0 0 auto; overflow: visible; }
            }
            @media (max-width: 760px) {
                .${NS}-cols, .${NS}-row { grid-template-columns: minmax(0, 1fr) 70px 84px; }
                .${NS}-last { display: none; }
                .${NS}-tiles { order: 3; width: 100%; margin-left: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
                .${NS}-head { padding: 12px 16px 0; }
                .${NS}-foot { display: none; }
                .${NS}-controls { padding: 8px 16px; }
                .${NS}-cols { padding-left: 16px; padding-right: 16px; }
                .${NS}-row { padding-left: 16px; padding-right: 16px; }
                .${NS}-close { margin-left: auto; }
            }
        `;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------------ the stats view

  function matches(name) {
    return !view.query || name.toLowerCase().includes(view.query);
  }

  // What a row shows depends on the "Include Stremio's older totals" box: off means only what this plugin measured.
  const filmPlays = (film) =>
    view.includeOld ? Math.max(film.libPlays, film.plays) : film.plays;
  const filmMs = (film) =>
    view.includeOld ? Math.max(film.libMs, film.ms) : film.ms;
  const filmFinished = (film) => film.libFinished || film.plays > 0;
  const showMs = (show) =>
    view.includeOld ? Math.max(show.libMs, show.ms) : show.ms;

  function sortItems(items, countOf, msOf) {
    const byName = (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const comparators = {
      recent: (a, b) => b.last - a.last || byName(a, b),
      name: byName,
      time: (a, b) => msOf(b) - msOf(a) || byName(a, b),
      count: (a, b) => countOf(b) - countOf(a) || byName(a, b),
    };
    return items.sort(comparators[view.sort] || comparators.recent);
  }

  function filmRow(film) {
    const row = el('div', `${NS}-row`);
    row.appendChild(
      Object.assign(el('div', `${NS}-name`, film.name), { title: film.name }),
    );
    const plays = filmPlays(film);
    if (plays > 0) {
      row.appendChild(el('div', `${NS}-num`, `${plays}${TIMES}`));
    } else {
      row.appendChild(
        el('div', `${NS}-started`, filmFinished(film) ? 'Watched' : 'Started'),
      );
    }
    row.appendChild(el('div', `${NS}-num`, formatTime(filmMs(film))));
    row.appendChild(el('div', `${NS}-num ${NS}-last`, formatDate(film.last)));
    return row;
  }

  function episodeRow(entry) {
    const row = el('div', `${NS}-row ${NS}-ep`);
    const lead = el('div', `${NS}-lead`);
    const label = el('div', `${NS}-name`);
    label.appendChild(el('span', `${NS}-code`, episodeLabel(entry)));
    if (entry.title) {
      label.appendChild(document.createTextNode(entry.title));
    }
    lead.appendChild(label);
    row.appendChild(lead);
    row.appendChild(
      entry.plays > 0
        ? el('div', `${NS}-num`, `${entry.plays}${TIMES}`)
        : el('div', `${NS}-started`, 'Partly'),
    );
    row.appendChild(el('div', `${NS}-num`, formatTime(entry.ms)));
    row.appendChild(el('div', `${NS}-num ${NS}-last`, formatDate(entry.last)));
    return row;
  }

  function fillEpisodes(container, show) {
    const frag = document.createDocumentFragment();
    show.episodes.forEach((entry) => frag.appendChild(episodeRow(entry)));
    const beforeMs = view.includeOld ? Math.max(0, show.libMs - show.ms) : 0;
    if (beforeMs > 0) {
      const row = el('div', `${NS}-row ${NS}-ep`);
      const lead = el('div', `${NS}-lead`);
      lead.appendChild(
        el(
          'div',
          `${NS}-name ${NS}-dim`,
          "Before tracking began (Stremio's own total, unchecked)",
        ),
      );
      row.appendChild(lead);
      row.appendChild(el('div', `${NS}-dim`, DASH));
      row.appendChild(el('div', `${NS}-num`, formatTime(beforeMs)));
      row.appendChild(el('div', `${NS}-dim ${NS}-last`, DASH));
      frag.appendChild(row);
    }
    if (!show.episodes.length) {
      frag.appendChild(
        el(
          'div',
          `${NS}-empty`,
          'No individual episodes recorded yet. They will appear here as you watch.',
        ),
      );
    }
    container.appendChild(frag);
  }

  function showGroup(show) {
    const group = el('div', `${NS}-group`);
    const header = el('button', `${NS}-row ${NS}-show`);
    header.type = 'button';

    const lead = el('div', `${NS}-lead`);
    const chevron = el('span', `${NS}-chev`);
    chevron.innerHTML = CHEVRON_ICON;
    const text = el('div', `${NS}-text`);
    text.style.minWidth = '0';
    text.appendChild(
      Object.assign(el('div', `${NS}-name`, show.name), { title: show.name }),
    );
    let meta = 'Watched before episode tracking began';
    if (show.plays > 0) {
      meta = `${show.plays} ${show.plays === 1 ? 'play' : 'plays'} recorded`;
    } else if (show.episodes.length > 0) {
      meta = 'Started, not finished yet';
    }
    text.appendChild(el('div', `${NS}-meta`, meta));
    lead.append(chevron, text);

    header.append(
      lead,
      el(
        'div',
        `${NS}-num`,
        show.episodes.length
          ? `${show.episodes.length} ${show.episodes.length === 1 ? 'ep' : 'eps'}`
          : DASH,
      ),
      el('div', `${NS}-num`, formatTime(showMs(show))),
      el('div', `${NS}-num ${NS}-last`, formatDate(show.last)),
    );

    const episodes = el('div', `${NS}-episodes`);
    episodes.hidden = true;
    let filled = false;
    const setOpen = (open) => {
      header.setAttribute('aria-expanded', String(open));
      episodes.hidden = !open;
      if (open && !filled) {
        filled = true;
        fillEpisodes(episodes, show);
      }
      if (open) {
        view.open.add(show.id);
      } else {
        view.open.delete(show.id);
      }
    };
    header.addEventListener('click', () =>
      setOpen(header.getAttribute('aria-expanded') !== 'true'),
    );
    setOpen(view.open.has(show.id));
    group.append(header, episodes);
    return group;
  }

  function renderList() {
    const list = overlay.list;
    list.textContent = '';
    const films = view.tab === 'films';
    const items = films
      ? sortItems(
          model.films.filter(
            (f) => matches(f.name) && (!view.finishedOnly || filmFinished(f)),
          ),
          filmPlays,
          filmMs,
        )
      : sortItems(
          model.shows.filter((s) => matches(s.name)),
          (s) => s.episodes.length * 1000 + s.plays,
          showMs,
        );
    const frag = document.createDocumentFragment();
    if (!items.length) {
      const nothing = films ? 'No films found.' : 'No shows found.';
      frag.appendChild(
        el(
          'div',
          `${NS}-empty`,
          view.query ? 'Nothing matches that search.' : nothing,
        ),
      );
    }
    items.forEach((item) =>
      frag.appendChild(films ? filmRow(item) : showGroup(item)),
    );
    list.appendChild(frag);
    list.scrollTop = 0;
    overlay.count.textContent = `${items.length} ${films ? (items.length === 1 ? 'film' : 'films') : items.length === 1 ? 'show' : 'shows'} listed`;
  }

  // Only the watch time tile depends on the "older totals" box; the other tiles just count titles.
  function updateTiles() {
    const totalMs =
      model.films.reduce((sum, f) => sum + filmMs(f), 0) +
      model.shows.reduce((sum, s) => sum + showMs(s), 0);
    overlay.tiles[3].valueEl.textContent = formatTime(totalMs);
    overlay.tiles[3].labelEl.textContent = view.includeOld
      ? "Total watch time (incl. Stremio's)"
      : 'Watch time tracked';
  }

  function renderChrome() {
    const films = view.tab === 'films';
    overlay.tabs.forEach((tab) =>
      tab.btn.setAttribute('aria-selected', String(tab.value === view.tab)),
    );
    overlay.finished.wrap.style.display = films ? '' : 'none';
    overlay.cols[0].textContent = films ? 'Film' : 'Show';
    overlay.cols[1].textContent = films ? 'Watched' : 'Episodes';
    overlay.cols[2].textContent = films ? 'Time' : 'Total time';
  }

  function tile(value, label) {
    const node = el('div', `${NS}-tile`);
    node.valueEl = el('div', `${NS}-tile-value`, value);
    node.labelEl = el('div', `${NS}-tile-label`, label);
    node.append(node.valueEl, node.labelEl);
    return node;
  }

  function buildOverlay() {
    const root = el('div', `${NS}-overlay`);
    root.id = OVERLAY_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Watch stats');
    const panel = el('div', `${NS}-panel`);

    const closeBtn = el('button', `${NS}-close`);
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener('click', closeStats);
    const tiles = el('div', `${NS}-tiles`);
    const tileEls = [
      tile(model.films.length.toLocaleString(), 'Films watched'),
      tile(model.shows.length.toLocaleString(), 'Shows watched'),
      tile(model.episodeCount.toLocaleString(), 'Episodes recorded'),
      tile(DASH, 'Watch time tracked'),
    ];
    tiles.append(...tileEls);
    const head = el('div', `${NS}-head`);
    head.append(el('h2', `${NS}-title`, 'Watch stats'), tiles, closeBtn);

    const controls = el('div', `${NS}-controls`);
    const tabsWrap = el('div', `${NS}-tabs`);
    tabsWrap.setAttribute('role', 'tablist');
    const tabs = [
      {
        value: 'films',
        label: `Films (${model.films.length.toLocaleString()})`,
      },
      {
        value: 'shows',
        label: `Shows (${model.shows.length.toLocaleString()})`,
      },
    ].map((def) => {
      const btn = el('button', `${NS}-tab`, def.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.addEventListener('click', () => {
        view.tab = def.value;
        renderChrome();
        renderList();
      });
      tabsWrap.appendChild(btn);
      return { value: def.value, btn };
    });

    const search = el('input', `${NS}-search`);
    search.type = 'search';
    search.placeholder = 'Search by title';
    search.setAttribute('aria-label', 'Search by title');
    search.autocomplete = 'off';
    search.addEventListener('input', () => {
      view.query = search.value.trim().toLowerCase();
      renderList();
    });

    const sort = el('select', `${NS}-select`);
    sort.setAttribute('aria-label', 'Sort by');
    SORTS.forEach((s) =>
      sort.appendChild(
        Object.assign(el('option', '', s.label), { value: s.value }),
      ),
    );
    sort.addEventListener('change', () => {
      view.sort = sort.value;
      renderList();
    });

    const finishedWrap = el('label', `${NS}-check`);
    const finishedBox = el('input');
    finishedBox.type = 'checkbox';
    finishedBox.addEventListener('change', () => {
      view.finishedOnly = finishedBox.checked;
      renderList();
    });
    finishedWrap.append(finishedBox, document.createTextNode('Finished only'));

    const oldWrap = el('label', `${NS}-check`);
    oldWrap.title =
      'Stremio keeps its own time and watch-count totals, but they can be wildly inflated. Off: times and counts come only from what this plugin has recorded.';
    const oldBox = el('input');
    oldBox.type = 'checkbox';
    oldBox.addEventListener('change', () => {
      view.includeOld = oldBox.checked;
      updateTiles();
      renderList();
    });
    oldWrap.append(
      oldBox,
      document.createTextNode("Include Stremio's older totals"),
    );

    const count = el('div', `${NS}-dim`);
    count.style.fontSize = '12px';
    controls.append(tabsWrap, search, sort, finishedWrap, oldWrap, count);

    const cols = el('div', `${NS}-cols`);
    const colEls = [
      el('div'),
      el('div'),
      el('div'),
      el('div', `${NS}-last`, 'Last watched'),
    ];
    colEls.forEach((c) => cols.appendChild(c));

    const list = el('div', `${NS}-list`);
    const since = history ? formatDate(history.since) : DASH;
    const footText = `Times and watch counts are recorded by this plugin from ${since}. Titles and last-watched dates come from your Stremio library; its own totals can be wildly inflated, so they are left out unless you tick "Include Stremio's older totals".`;
    const foot = el('div', `${NS}-foot`, footText);
    foot.title = footText;

    panel.append(head, controls, cols, list, foot);
    root.appendChild(panel);

    root.addEventListener('mousedown', (e) => {
      if (e.target === root) {
        closeStats();
      }
    });
    // Keep Stremio's own shortcuts from reacting to typing in here.
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        closeStats();
      }
    });

    return {
      root,
      list,
      count,
      search,
      tabs,
      tiles: tileEls,
      cols: colEls,
      finished: { wrap: finishedWrap, box: finishedBox },
    };
  }

  function openStats() {
    if (overlay) {
      return;
    }
    injectStyles();
    view = {
      tab: 'films',
      query: '',
      sort: 'recent',
      finishedOnly: false,
      includeOld: false,
      open: new Set(),
    };
    model = buildModel();
    overlay = buildOverlay();
    document.body.appendChild(overlay.root);
    updateTiles();
    renderChrome();
    renderList();
    overlay.search.focus();
  }

  function closeStats() {
    if (overlay) {
      overlay.root.remove();
    }
    overlay = null;
  }

  // ------------------------------------------------------------------ the Board button

  function isBoardRoute() {
    const hash = window.location.hash;
    return (
      hash === '' || hash === '#' || hash === '#/' || hash.startsWith('#/?')
    );
  }

  // The first row heading on the Board (normally "Continue watching"), so the button can sit right after it.
  // Stremio's class names end in a generated suffix, so match on the stable part of each name. A previous route
  // can stay in the page underneath, so only look inside the newest one.
  function findHeading() {
    const routes = document.querySelectorAll('.route-container');
    const scope = routes.length ? routes[routes.length - 1] : document;
    return (
      scope.querySelector(
        '[class*="continue-watching-row-"] [class*="title-container-"]',
      ) ||
      scope.querySelector(
        '[class*="meta-row-container-"] [class*="title-container-"]',
      )
    );
  }

  function mountButton(anchor) {
    injectStyles();
    unmountButton();
    button = el(
      'button',
      anchor ? `${NS}-button` : `${NS}-button ${NS}-floating`,
    );
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'Your watch stats';
    const icon = el('span');
    icon.style.display = 'inline-flex';
    icon.innerHTML = GRAPH_ICON;
    button.append(icon, el('span', '', 'Stats'));
    button.addEventListener('click', openStats);
    (anchor || document.body).appendChild(button);
    buttonAnchor = anchor;
  }

  function unmountButton() {
    if (button) {
      button.remove();
    }
    button = null;
    buttonAnchor = null;
  }

  function syncButton(hasVideo) {
    if (!isBoardRoute() || hasVideo) {
      noAnchorTicks = 0;
      unmountButton();
      closeStats();
      return;
    }
    if (button && !button.isConnected) {
      unmountButton(); // Stremio rebuilt the row and took the button with it
    }
    const anchor = findHeading();
    if (anchor) {
      noAnchorTicks = 0;
      if (!button || buttonAnchor !== anchor) {
        mountButton(anchor); // first time, after a rebuild, or moving in from the corner
      }
      return;
    }
    noAnchorTicks += 1;
    if (!button && noAnchorTicks >= FALLBACK_AFTER_TICKS) {
      mountButton(null); // no heading to attach to: keep it reachable in the corner
    }
  }

  // ------------------------------------------------------------------ main loop

  function tick() {
    const video = document.querySelector('video');
    syncButton(!!video);
    if (history) {
      updateSession(video);
      if (dirty && Date.now() - lastSaveAt >= SAVE_EVERY_MS) {
        saveHistory();
      }
    }
  }

  function onPageHide() {
    saveHistory();
  }

  function teardown() {
    clearInterval(timer);
    window.removeEventListener('timeupdate', onTimeUpdate, true);
    window.removeEventListener('ended', onVideoEnded, true);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('hashchange', tick);
    saveHistory();
    unmountButton();
    closeStats();
    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
    if (window.__watchStatsTeardown === teardown) {
      delete window.__watchStatsTeardown;
    }
  }

  // Media events do not bubble, so listen in the capture phase.
  window.addEventListener('timeupdate', onTimeUpdate, true);
  window.addEventListener('ended', onVideoEnded, true);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('hashchange', tick);
  const timer = setInterval(tick, TICK_MS);
  window.__watchStatsTeardown = teardown;

  loadHistory()
    .then(tick)
    .catch((err) =>
      log('error', `Could not start: ${(err && err.message) || err}`),
    );
})();
