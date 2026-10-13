/**
 * @name Sleep Timer
 * @description Pauses playback and asks "Are you still watching?" after a period of inactivity, then leaves the player if nobody answers. A small gear chip in the player (bottom left) opens a panel to adjust the timings.
 * @version 2.2.0
 * @author dotcom
 * https://github.com/dotcme/stremio-sleep-timer/ - Is the original, modified by plain.
 */

(function () {
  'use strict';

  // If an earlier copy is still running (plugin toggled off and on without a reload), remove it
  // first so timers, listeners and overlays never stack up.
  if (typeof window.__sleepTimerTeardown === 'function') {
    try {
      window.__sleepTimerTeardown();
    } catch (_) {
      // nothing to clean up
    }
  }

  // ------------------------------------------------------------------ configuration

  // What you get if you never open the settings panel. Anything saved from the panel overrides these.
  const DEFAULTS = {
    enabled: true,
    idleMinutes: 90, // minutes without input (or of playback, if ignoreInput) before the prompt appears
    ignoreInput: false, // true: count playback time only, so mouse and keyboard never restart the timer
    promptSeconds: 120, // seconds the prompt waits for an answer
    onTimeout: 'back', // 'back' | 'home' | 'pause'
    showCountdown: true, // countdown on the prompt itself
    cornerTimer: 'auto', // top-right countdown: 'auto' | 'always' | 'off'
  };
  const LIMITS = { idleMinutes: [1, 1440], promptSeconds: [10, 3600] };
  const TIMEOUT_ACTIONS = ['back', 'home', 'pause'];
  const TIMEOUT_LABELS = {
    back: 'Go back',
    home: 'Go home',
    pause: 'Stay paused',
  };
  const TIMEOUT_TEXT = {
    back: 'Going back',
    home: 'Returning home',
    pause: 'Closing this prompt',
  };
  const CORNER_MODES = ['auto', 'always', 'off'];
  const CORNER_LABELS = { auto: 'Smart', always: 'Always', off: 'Off' };
  const IDLE_PRESETS = [30, 45, 60, 90, 120, 180];

  // Shown on Stremio's own Settings page (Enhanced > Plugins > gear). The in-player panel edits the same values.
  // Avoid double quotes in labels: the host puts them inside an HTML attribute.
  const SCHEMA = [
    {
      key: 'enabled',
      type: 'toggle',
      label: 'Enable sleep timer',
      description:
        'Turn the inactivity check on or off without disabling the plugin.',
      defaultValue: DEFAULTS.enabled,
    },
    {
      key: 'idleMinutes',
      type: 'input',
      label: 'Ask after (minutes)',
      description:
        'Minutes without mouse or keyboard input (or of playback, if input is ignored) before playback is paused and you are asked if you are still watching. 1 to 1440.',
      defaultValue: String(DEFAULTS.idleMinutes),
    },
    {
      key: 'ignoreInput',
      type: 'toggle',
      label: 'Ignore mouse and keyboard',
      description:
        'Count playback time only, so changing the volume or moving the mouse never restarts the countdown.',
      defaultValue: DEFAULTS.ignoreInput,
    },
    {
      key: 'promptSeconds',
      type: 'input',
      label: 'Wait for an answer (seconds)',
      description:
        'How long the prompt waits before the action below happens. 10 to 3600.',
      defaultValue: String(DEFAULTS.promptSeconds),
    },
    {
      key: 'onTimeout',
      type: 'select',
      label: 'When it stops',
      description:
        'What to do after an ignored prompt, or at the end of an episode when Stop after this episode is on.',
      defaultValue: DEFAULTS.onTimeout,
      options: TIMEOUT_ACTIONS.map((value) => ({
        label: TIMEOUT_LABELS[value],
        value,
      })),
    },
    {
      key: 'showCountdown',
      type: 'toggle',
      label: 'Countdown on the prompt',
      description: 'Show the time remaining on the prompt.',
      defaultValue: DEFAULTS.showCountdown,
    },
    {
      key: 'cornerTimer',
      type: 'select',
      label: 'Timer in the top right',
      description:
        'Smart shows it all the time when mouse and keyboard are ignored, and only for the last 5 minutes otherwise.',
      defaultValue: DEFAULTS.cornerTimer,
      options: CORNER_MODES.map((value) => ({
        label: CORNER_LABELS[value],
        value,
      })),
    },
  ];

  // ------------------------------------------------------------------ constants

  const PLUGIN_ID = (
    (document.currentScript && document.currentScript.id) ||
    'sleeptimer.plugin.js'
  ).replace(/\.plugin\.js$/, '');
  const OVERLAY_ID = 'stremio-sleep-timer-overlay';
  const CHIP_ID = 'stremio-sleep-timer-chip';
  const PANEL_ID = 'stremio-sleep-timer-panel';
  const TICK_MS = 1000;
  const FADE_MS = 400;
  const CORNER_ID = 'stremio-sleep-timer-corner';
  const CORNER_WARN_MS = 5 * 60 * 1000; // in "smart" mode the corner timer appears for the last few minutes
  const PLAYER_GONE_RESET_MS = 2 * 60 * 1000; // leaving the player for this long starts the timer afresh
  const MAX_TICK_STEP_MS = 2 * 60 * 1000; // longer gaps (the Mac was asleep) are not counted as playback
  const END_WAIT_MS = 4000; // how long to wait for Stremio to move on after an episode ends
  const HOLD_PAUSE_MS = 15000; // after stopping, keep autoplay paused this long unless you press something
  const NOTICE_MS = 6000; // how long a short message stays in the top-right box
  const CHIP_FIRST_SHOW_MS = 8000; // how long the chip stays visible when a video starts
  const CHIP_ACTIVE_MS = 3500; // how long it stays visible after the mouse last moved
  const POINTER_EVENTS = [
    'mousemove',
    'mousedown',
    'pointerdown',
    'touchstart',
  ];
  const ACTIVITY_EVENTS = [...POINTER_EVENTS, 'wheel']; // keydown is handled separately
  const LISTENER_OPTIONS = { capture: true, passive: true };

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const ACCENT = 'linear-gradient(135deg, #6366f1, #a855f7)';
  const MUTED = 'color: rgba(255, 255, 255, 0.55); font-size: 12px;';
  const GEAR_PATH =
    'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';

  // Inside the host this is the per-plugin scoped API; fall back to the global one if it is missing.
  const api =
    typeof StremioEnhancedAPI !== 'undefined'
      ? StremioEnhancedAPI
      : window.StremioEnhancedAPI;

  // ------------------------------------------------------------------ state

  const warned = new Set(); // settings problems already reported
  let rawSettings = {}; // values as saved (strings for inputs and selects, booleans for toggles)
  let cfg = normalise({}); // validated values actually used
  let lastActivity = Date.now();
  let playedMs = 0; // playback time counted so far (used when mouse and keyboard are ignored)
  let lastTickAt = Date.now();
  let lastVideoAt = Date.now(); // last time a video was on screen
  let corner = null; // the top-right box (countdown, "stops after this episode", short notices)
  let stopAfterEpisode = false; // one-shot: stop when this episode ends instead of playing the next one
  let endedAt = 0; // when the episode ended (only tracked while stopAfterEpisode is on)
  let endedHash = ''; // the route at that moment
  let holdSince = 0; // after stopping, autoplay stays paused until you press something
  let holdPauseUntil = 0;
  let lastIntentAt = 0; // last click, tap or key press
  let notice = null; // short message for the top-right box: { text, until }
  let prompt = null; // the "still watching?" prompt while it is on screen
  let deadline = 0; // when the prompt gives up waiting
  let chip = null; // the gear chip
  let chipLabel = null;
  let chipKey = null; // identifies the current video so the chip reappears for each episode
  let chipShown = false;
  let chipHideAt = 0;
  let panel = null; // the settings panel: { root, ctl }

  // ------------------------------------------------------------------ helpers

  function log(level, message) {
    try {
      api.logger[level](message);
    } catch (_) {
      console[level === 'info' ? 'log' : level]('[Sleep Timer]', message);
    }
  }

  // Settings are re-validated on every change, so only report each problem once.
  function warnOnce(message) {
    if (warned.has(message)) {
      return;
    }
    warned.add(message);
    log('warn', message);
  }

  function h(tag, css, props, children) {
    const node = document.createElement(tag);
    if (css) {
      node.style.cssText = css;
    }
    if (props) {
      Object.assign(node, props);
    }
    (children || []).forEach(
      (child) =>
        child &&
        node.appendChild(
          typeof child === 'string' ? document.createTextNode(child) : child,
        ),
    );
    return node;
  }

  function parseBool(raw, fallback) {
    if (raw === true || raw === 'true') {
      return true;
    }
    if (raw === false || raw === 'false') {
      return false;
    }
    return fallback;
  }

  // Inputs are saved as text, so anything can arrive here: junk falls back, out-of-range values are clamped.
  function parseNumber(raw, fallback, [min, max], name) {
    const n = parseFloat(String(raw == null ? '' : raw).replace(',', '.'));
    if (!Number.isFinite(n)) {
      if (raw != null && raw !== '') {
        warnOnce(`${name}: "${raw}" is not a number, using ${fallback}`);
      }
      return fallback;
    }
    const clamped = Math.min(max, Math.max(min, n));
    const value = Math.round(clamped);
    if (clamped !== n) {
      warnOnce(`${name}: ${n} is outside ${min}-${max}, using ${value}`);
    }
    return value;
  }

  function normalise(raw) {
    return {
      enabled: parseBool(raw.enabled, DEFAULTS.enabled),
      idleMinutes: parseNumber(
        raw.idleMinutes,
        DEFAULTS.idleMinutes,
        LIMITS.idleMinutes,
        'Ask after',
      ),
      ignoreInput: parseBool(raw.ignoreInput, DEFAULTS.ignoreInput),
      promptSeconds: parseNumber(
        raw.promptSeconds,
        DEFAULTS.promptSeconds,
        LIMITS.promptSeconds,
        'Wait for an answer',
      ),
      onTimeout: TIMEOUT_ACTIONS.includes(raw.onTimeout)
        ? raw.onTimeout
        : DEFAULTS.onTimeout,
      showCountdown: parseBool(raw.showCountdown, DEFAULTS.showCountdown),
      cornerTimer: CORNER_MODES.includes(raw.cornerTimer)
        ? raw.cornerTimer
        : DEFAULTS.cornerTimer,
    };
  }

  // m:ss, or h:mm:ss once it is an hour or more
  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
      : `${minutes}:${seconds}`;
  }

  function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    if (totalMinutes >= 60) {
      const minutes = totalMinutes % 60;
      return `${Math.floor(totalMinutes / 60)}h${minutes ? ` ${minutes}m` : ''}`;
    }
    return totalMinutes >= 1
      ? `${totalMinutes}m`
      : `${Math.max(0, Math.round(ms / 1000))}s`;
  }

  // ------------------------------------------------------------------ timer

  // Time left before the prompt. With input ignored it only counts playback time, so nothing
  // you press can move it; otherwise it is the time since you last touched something.
  function remainingMs() {
    const limit = cfg.idleMinutes * 60000;
    return limit - (cfg.ignoreInput ? playedMs : Date.now() - lastActivity);
  }

  function restartTimer() {
    playedMs = 0;
    lastActivity = Date.now();
  }

  // ------------------------------------------------------------------ settings

  function applyConfig(incoming) {
    rawSettings = { ...rawSettings, ...(incoming || {}) };
    const next = normalise(rawSettings);
    const changed = JSON.stringify(next) !== JSON.stringify(cfg);
    // Picking a new length or switching mode starts the timer afresh.
    const restart =
      next.ignoreInput !== cfg.ignoreInput ||
      next.idleMinutes !== cfg.idleMinutes;
    cfg = next;
    if (restart) {
      restartTimer();
    }
    if (changed) {
      log('info', `Settings: ${JSON.stringify(cfg)}`);
      updateChip();
      renderPanel();
    }
  }

  // Used by the in-player panel: takes effect immediately and is saved for next time.
  function setSetting(key, value) {
    applyConfig({ [key]: value });
    Promise.resolve()
      .then(() => api.saveSetting(key, value))
      .catch((err) =>
        log('warn', `Could not save ${key}: ${(err && err.message) || err}`),
      );
  }

  async function loadSavedSettings() {
    const saved = {};
    for (const item of SCHEMA) {
      try {
        const value = await api.getSetting(item.key);
        if (value !== null && value !== undefined) {
          saved[item.key] = value;
        }
      } catch (_) {
        // nothing saved yet
      }
    }
    applyConfig(saved);
  }

  async function initSettings() {
    if (!api || typeof api.registerSettings !== 'function') {
      log('warn', 'Settings API not available, using defaults');
      return;
    }
    // The host remembers a registered schema until the app restarts, so clear it first to pick up changes on reload.
    try {
      await window.StremioEnhancedAPI.clearRegisteredSettings(PLUGIN_ID);
    } catch (_) {
      // not registered
    }
    try {
      await api.registerSettings(SCHEMA);
    } catch (err) {
      log(
        'warn',
        `Could not register settings: ${(err && err.message) || err}`,
      );
    }
    await loadSavedSettings();
    try {
      api.onSettingsSaved(applyConfig);
    } catch (_) {
      // older host without change notifications
    }
  }

  // ------------------------------------------------------------------ "Are you still watching?" prompt

  function buildPrompt() {
    const hiddenTransform = 'scale(0.95) translateY(10px)';
    const overlay = h(
      'div',
      `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            z-index: 999999;
            display: flex; align-items: center; justify-content: center;
            background: rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
            opacity: 0; transition: opacity ${FADE_MS / 1000}s ease;
            font-family: ${FONT}; color: #ffffff;
        `,
      { id: OVERLAY_ID },
    );
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', `${OVERLAY_ID}-title`);

    const dialog = h(
      'div',
      `
            background: rgba(20, 20, 25, 0.75);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 20px; padding: 48px 64px; text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
            transform: ${hiddenTransform};
            transition: transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        `,
    );

    const title = h(
      'h2',
      'margin: 0 0 8px 0; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;',
      { id: `${OVERLAY_ID}-title`, textContent: 'Are you still watching?' },
    );

    const message = h(
      'p',
      `margin: 0 0 ${cfg.showCountdown ? 10 : 32}px 0; font-size: 16px; color: rgba(255, 255, 255, 0.5);`,
      { textContent: 'Playback has been paused due to inactivity.' },
    );

    const countdown = h(
      'p',
      'margin: 0 0 32px 0; font-size: 15px; color: rgba(255, 255, 255, 0.75); font-variant-numeric: tabular-nums;',
    );
    countdown.style.display = cfg.showCountdown ? '' : 'none';

    const button = h(
      'button',
      `
            background: ${ACCENT}; color: white; border: none;
            padding: 14px 40px; font-size: 16px; font-weight: 600; border-radius: 99px;
            cursor: pointer; transition: all 0.2s ease;
            box-shadow: 0 8px 20px -6px rgba(168, 85, 247, 0.6);
            outline: 2px solid rgba(255, 255, 255, 0.35); outline-offset: 3px;
        `,
      { type: 'button', textContent: "Yes, I'm here" },
    );
    button.onmouseenter = () => {
      button.style.transform = 'translateY(-2px) scale(1.02)';
      button.style.boxShadow = '0 12px 24px -6px rgba(168, 85, 247, 0.8)';
    };
    button.onmouseleave = () => {
      button.style.transform = 'translateY(0) scale(1)';
      button.style.boxShadow = '0 8px 20px -6px rgba(168, 85, 247, 0.6)';
    };
    button.onmousedown = () => {
      button.style.transform = 'scale(0.98)';
    };
    button.onclick = confirmStillWatching;

    dialog.append(title, message, countdown, button);
    overlay.appendChild(dialog);
    return { overlay, dialog, countdown, button, hiddenTransform };
  }

  function showPrompt(video) {
    closePanel();
    video.pause();
    deadline = Date.now() + cfg.promptSeconds * 1000;
    prompt = buildPrompt();
    document.body.appendChild(prompt.overlay);
    updateCountdown();

    const shown = prompt;
    requestAnimationFrame(() => {
      if (prompt !== shown) {
        // already answered before the first frame
        return;
      }
      shown.overlay.style.opacity = '1';
      shown.dialog.style.transform = 'scale(1) translateY(0)';
    });
    shown.button.focus();
    log(
      'info',
      cfg.ignoreInput
        ? `${cfg.idleMinutes} min of playback reached, asking if you are still watching`
        : `No input for ${cfg.idleMinutes} min, asking if you are still watching`,
    );
  }

  function updateCountdown() {
    if (!prompt) {
      return;
    }
    prompt.countdown.textContent = `${TIMEOUT_TEXT[cfg.onTimeout]} in ${formatCountdown(deadline - Date.now())}`;
  }

  function closePrompt() {
    const closing = prompt;
    if (!closing) {
      return;
    }
    prompt = null;
    closing.overlay.style.opacity = '0';
    closing.dialog.style.transform = closing.hiddenTransform;
    setTimeout(() => closing.overlay.remove(), FADE_MS);
  }

  function confirmStillWatching() {
    if (!prompt) {
      return;
    }
    restartTimer();
    const video = document.querySelector('video');
    closePrompt();
    if (video) {
      const resumed = video.play();
      if (resumed && resumed.catch) {
        resumed.catch(() => {
          // the user can press play
        });
      }
    }
  }

  function onPromptExpired() {
    const action = cfg.onTimeout;
    closePrompt(); // the video stays paused
    restartTimer(); // the next video gets a full period
    log('info', `Prompt ignored, action: ${action}`);
    if (action === 'home') {
      window.location.hash = '#/';
    } else if (action === 'back') {
      window.history.back();
    }
  }

  // ------------------------------------------------------------------ gear chip

  function mountChip() {
    unmountChip();
    chipLabel = h('span');
    const icon = h('span', 'display: inline-flex;');
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${GEAR_PATH}"></path></svg>`;
    chip = h(
      'button',
      `
            position: fixed; left: 20px; bottom: 96px; z-index: 99998;
            display: flex; align-items: center; gap: 8px;
            padding: 8px 14px 8px 11px; border-radius: 99px;
            background: rgba(20, 20, 25, 0.72); color: rgba(255, 255, 255, 0.9);
            border: 1px solid rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            font: 600 13px/1 ${FONT}; cursor: pointer;
            opacity: 0; transform: translateY(6px); pointer-events: none;
            transition: opacity 0.3s ease, transform 0.3s ease, background 0.2s ease;
        `,
      { id: CHIP_ID, type: 'button', title: 'Sleep timer settings' },
      [icon, chipLabel],
    );
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.onmouseenter = () => {
      chip.style.background = 'rgba(40, 40, 52, 0.85)';
    };
    chip.onmouseleave = () => {
      chip.style.background = 'rgba(20, 20, 25, 0.72)';
    };
    chip.onmousedown = (e) => e.preventDefault(); // keep focus on the player so Space still plays and pauses
    chip.onclick = togglePanel;
    document.body.appendChild(chip);
    chipShown = false;
    updateChip();
  }

  function unmountChip() {
    closePanel();
    if (chip) {
      chip.remove();
    }
    chip = null;
    chipLabel = null;
    chipShown = false;
  }

  function updateChip() {
    if (chipLabel) {
      chipLabel.textContent = `Sleep timer \u00b7 ${cfg.enabled ? formatDuration(cfg.idleMinutes * 60000) : 'off'}`;
    }
  }

  // Sit just above Stremio's control bar so the chip never covers the play button.
  function placeChip() {
    let bottom = 96;
    try {
      const bar = document.querySelector('[class*="control-bar-container"]');
      const rect = bar && bar.getBoundingClientRect();
      if (rect && rect.height > 0) {
        bottom = Math.max(16, Math.round(window.innerHeight - rect.top + 12));
      }
    } catch (_) {
      // keep the default
    }
    chip.style.bottom = `${bottom}px`;
  }

  function showChip() {
    if (!chip || chipShown) {
      return;
    }
    chipShown = true;
    placeChip();
    chip.style.opacity = '1';
    chip.style.transform = 'translateY(0)';
    chip.style.pointerEvents = 'auto';
  }

  function hideChip() {
    if (!chip || !chipShown) {
      return;
    }
    chipShown = false;
    chip.style.opacity = '0';
    chip.style.transform = 'translateY(6px)';
    chip.style.pointerEvents = 'none';
  }

  // Create the chip when a video appears (and again for each new episode), remove it when the player closes.
  function syncChip(video) {
    const key = video ? window.location.hash : null;
    if (key !== chipKey) {
      chipKey = key;
      if (video) {
        mountChip();
        chipHideAt = Date.now() + CHIP_FIRST_SHOW_MS;
      } else {
        unmountChip();
      }
    }
    if (!chip) {
      return;
    }
    if (!prompt && (panel || Date.now() < chipHideAt)) {
      showChip();
    } else {
      hideChip();
    }
    updatePanelStatus(video);
  }

  // ------------------------------------------------------------------ stop after this episode

  function isPlayerRoute(hash) {
    return hash.startsWith('#/player');
  }

  // One-shot: it clears itself once it has done its job, so tomorrow's first episode plays on as normal.
  function setStopAfter(value) {
    stopAfterEpisode = value;
    endedAt = 0;
    endedHash = '';
    renderPanel();
  }

  // Stremio handles the end of an episode itself (marks it watched, moves "continue watching" on) and then
  // jumps to the next one. We only note when it ended, then step in as soon as it moves to another player.
  function onVideoEnded(e) {
    if (!stopAfterEpisode || !e.target || e.target.tagName !== 'VIDEO') {
      return;
    }
    endedAt = Date.now();
    endedHash = window.location.hash;
    log('info', 'Episode ended, waiting to see what Stremio does next');
  }

  function checkStopAfterEpisode() {
    if (!stopAfterEpisode || !endedAt) {
      return;
    }
    const hash = window.location.hash;
    if (hash !== endedHash) {
      if (isPlayerRoute(hash)) {
        finishStop(); // Stremio moved on to the next episode
      } else {
        setStopAfter(false); // it left the player by itself (last episode, or autoplay is off)
        restartTimer();
      }
      return;
    }
    if (Date.now() - endedAt > END_WAIT_MS) {
      finishStop(); // nothing happened, so leave ourselves
    }
  }

  function finishStop() {
    const action = cfg.onTimeout;
    setStopAfter(false);
    restartTimer();
    holdSince = Date.now();
    holdPauseUntil = holdSince + HOLD_PAUSE_MS;
    pauseVideos();
    log('info', `Stopped after the episode, action: ${action}`);
    if (action === 'home') {
      window.location.hash = '#/';
    } else if (action === 'back') {
      window.history.back();
    } else {
      notice = {
        text: 'Stopped after this episode',
        until: Date.now() + NOTICE_MS,
      };
    }
  }

  // After stopping, the next episode may still try to autoplay. Keep it paused until you press something.
  function holdingPause() {
    return Date.now() < holdPauseUntil && lastIntentAt <= holdSince;
  }

  function pauseVideos() {
    document.querySelectorAll('video').forEach((video) => {
      if (!video.paused) {
        video.pause();
      }
    });
  }

  function onVideoPlay(e) {
    if (holdingPause() && e.target && e.target.tagName === 'VIDEO') {
      e.target.pause();
    }
  }

  // ------------------------------------------------------------------ corner countdown

  // What the top-right timer should say, or null when it should stay hidden.
  function timerText(video, playing) {
    if (!cfg.enabled || cfg.cornerTimer === 'off' || !video) {
      return null;
    }
    const remaining = remainingMs();
    // Smart: a fixed timer is always worth showing; the idle one resets on every touch, so only warn near the end.
    if (
      cfg.cornerTimer === 'auto' &&
      !cfg.ignoreInput &&
      remaining > CORNER_WARN_MS
    ) {
      return null;
    }
    if (playing) {
      return `Pauses in ${formatCountdown(remaining)}`;
    }
    // Paused: the idle timer has nothing pending, but a fixed timer is still counting down to it.
    return cfg.ignoreInput
      ? `Timer paused \u00b7 ${formatCountdown(remaining)}`
      : null;
  }

  // Every line the top-right box should show: the timer, a reminder that a stop is armed, and any short notice.
  function cornerLines(video, playing) {
    const lines = [];
    const timer = timerText(video, playing);
    if (timer) {
      lines.push(timer);
    }
    if (stopAfterEpisode && video) {
      lines.push('Stops after this episode');
    }
    if (notice && Date.now() < notice.until) {
      lines.push(notice.text);
    }
    return lines;
  }

  // Enhanced's optional custom title bar sits at the top; stay below it when it is there.
  function placeCorner() {
    const titleBar = document.querySelector('.title-bar');
    corner.style.top = `${titleBar && titleBar.offsetHeight > 0 ? titleBar.offsetHeight + 12 : 16}px`;
  }

  function updateCorner(video, playing) {
    const text = cornerLines(video, playing).join('\n');
    if (!text) {
      if (video) {
        hideCorner();
      } else {
        removeCorner();
      }
      return;
    }
    if (!corner) {
      corner = h(
        'div',
        `
                position: fixed; top: 16px; right: 20px; z-index: 99997; pointer-events: none;
                padding: 7px 12px; border-radius: 14px; text-align: right; white-space: pre-line;
                background: rgba(20, 20, 25, 0.6); color: rgba(255, 255, 255, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.08);
                backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                font: 600 13px/1.5 ${FONT}; font-variant-numeric: tabular-nums; letter-spacing: 0.2px;
                opacity: 0; transition: opacity 0.3s ease;
            `,
        { id: CORNER_ID },
      );
      corner.setAttribute('aria-hidden', 'true');
      document.body.appendChild(corner);
    }
    placeCorner();
    if (corner.textContent !== text) {
      corner.textContent = text;
    }
    corner.style.opacity = '1';
  }

  function hideCorner() {
    if (corner) {
      corner.style.opacity = '0';
    }
  }

  function removeCorner() {
    if (corner) {
      corner.remove();
    }
    corner = null;
  }

  // ------------------------------------------------------------------ settings panel

  function makeSwitch(label, onToggle) {
    let on = false;
    const knob = h(
      'span',
      'position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.2s ease;',
    );
    const el = h(
      'button',
      'position: relative; flex-shrink: 0; width: 42px; height: 24px; border: none; border-radius: 99px; padding: 0; cursor: pointer; transition: background 0.2s ease;',
      { type: 'button' },
      [knob],
    );
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-label', label);
    el.onclick = () => onToggle(!on);
    const set = (value) => {
      on = !!value;
      el.setAttribute('aria-checked', String(on));
      el.style.background = on ? ACCENT : 'rgba(255, 255, 255, 0.2)';
      knob.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
    };
    set(false);
    return { el, set };
  }

  function makeNumberField(key, unit, label) {
    const input = h(
      'input',
      `
            width: 64px; box-sizing: border-box; padding: 7px 8px; text-align: center;
            background: rgba(255, 255, 255, 0.08); color: #fff; font: 600 14px ${FONT};
            border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px; outline: none;
        `,
      {
        type: 'number',
        min: String(LIMITS[key][0]),
        max: String(LIMITS[key][1]),
        step: '1',
      },
    );
    input.addEventListener('change', () => {
      const value = parseNumber(input.value, cfg[key], LIMITS[key], label);
      input.value = String(value);
      setSetting(key, String(value));
    });
    const el = h(
      'label',
      'display: flex; align-items: center; gap: 8px;',
      null,
      [input, h('span', MUTED, { textContent: unit })],
    );
    return { el, input };
  }

  function makeChoice(text, onPick) {
    const btn = h(
      'button',
      `border: none; color: #fff; cursor: pointer; font: 600 12px/1 ${FONT}; padding: 8px 10px; border-radius: 99px; transition: background 0.15s ease;`,
      { type: 'button', textContent: text },
    );
    btn.onclick = onPick;
    return btn;
  }

  function styleChoice(btn, active) {
    btn.style.background = active ? ACCENT : 'rgba(255, 255, 255, 0.1)';
    btn.setAttribute('aria-pressed', String(active));
  }

  function makeRow(title, hint, control) {
    const hintEl = hint
      ? h('div', `${MUTED} margin-top: 2px;`, { textContent: hint })
      : null;
    const text = h('div', 'min-width: 0;', null, [
      h('div', 'font-size: 14px; font-weight: 600;', { textContent: title }),
      hintEl,
    ]);
    const row = h(
      'div',
      'display: flex; align-items: center; justify-content: space-between; gap: 12px;',
      null,
      control ? [text, control] : [text],
    );
    row.hintEl = hintEl;
    return row;
  }

  function buildPanel() {
    const ctl = {};
    ctl.enabled = makeSwitch('Enable sleep timer', (value) =>
      setSetting('enabled', value),
    );
    ctl.countdown = makeSwitch('Countdown on the prompt', (value) =>
      setSetting('showCountdown', value),
    );
    ctl.ignore = makeSwitch('Ignore mouse and keyboard', (value) =>
      setSetting('ignoreInput', value),
    );
    ctl.stop = makeSwitch('Stop after this episode', (value) => {
      setStopAfter(value);
      log(
        'info',
        value
          ? 'Will stop after this episode'
          : 'Stop after this episode is off',
      );
    });
    ctl.idle = makeNumberField('idleMinutes', 'min', 'Ask after');
    ctl.seconds = makeNumberField('promptSeconds', 'sec', 'Wait for an answer');
    ctl.presets = IDLE_PRESETS.map((minutes) => ({
      minutes,
      btn: makeChoice(formatDuration(minutes * 60000), () =>
        setSetting('idleMinutes', String(minutes)),
      ),
    }));
    ctl.actions = TIMEOUT_ACTIONS.map((value) => ({
      value,
      btn: makeChoice(TIMEOUT_LABELS[value], () =>
        setSetting('onTimeout', value),
      ),
    }));
    ctl.corners = CORNER_MODES.map((value) => ({
      value,
      btn: makeChoice(CORNER_LABELS[value], () =>
        setSetting('cornerTimer', value),
      ),
    }));
    ctl.status = h('div', `${MUTED} margin-top: 4px; line-height: 1.4;`);

    const reset = h(
      'button',
      `background: none; border: none; color: rgba(255, 255, 255, 0.6); cursor: pointer; font: 600 12px ${FONT}; padding: 6px 4px;`,
      { type: 'button', textContent: 'Reset to defaults' },
    );
    reset.onclick = () => {
      setSetting('enabled', DEFAULTS.enabled);
      setSetting('idleMinutes', String(DEFAULTS.idleMinutes));
      setSetting('ignoreInput', DEFAULTS.ignoreInput);
      setSetting('promptSeconds', String(DEFAULTS.promptSeconds));
      setSetting('onTimeout', DEFAULTS.onTimeout);
      setSetting('showCountdown', DEFAULTS.showCountdown);
      setSetting('cornerTimer', DEFAULTS.cornerTimer);
    };
    const done = h(
      'button',
      `background: ${ACCENT}; border: none; color: #fff; cursor: pointer; font: 600 13px ${FONT}; padding: 9px 22px; border-radius: 99px;`,
      { type: 'button', textContent: 'Done' },
    );
    done.onclick = closePanel;

    const pillRow = 'display: flex; flex-wrap: wrap; gap: 6px;';
    ctl.idleRow = makeRow(
      'Ask after',
      'With no mouse or keyboard input',
      ctl.idle.el,
    );
    ctl.body = h(
      'div',
      'display: flex; flex-direction: column; gap: 12px; transition: opacity 0.2s ease;',
      null,
      [
        ctl.idleRow,
        h(
          'div',
          pillRow,
          null,
          ctl.presets.map((p) => p.btn),
        ),
        makeRow(
          'Ignore mouse and keyboard',
          'Counts playback time only, so volume or mouse changes never restart it',
          ctl.ignore.el,
        ),
        makeRow(
          'Wait for an answer',
          'Before the action below',
          ctl.seconds.el,
        ),
        makeRow(
          'When it stops',
          'After an ignored prompt, or at the end of an episode',
          null,
        ),
        h(
          'div',
          pillRow,
          null,
          ctl.actions.map((a) => a.btn),
        ),
        makeRow('Countdown on the prompt', null, ctl.countdown.el),
        makeRow(
          'Timer in the top right',
          'Smart: always when ignoring input, last 5 min otherwise',
          null,
        ),
        h(
          'div',
          pillRow,
          null,
          ctl.corners.map((c) => c.btn),
        ),
      ],
    );

    const root = h(
      'div',
      `
            position: fixed; left: 20px; bottom: 140px; z-index: 99999;
            width: 330px; box-sizing: border-box; max-height: 80vh; overflow-y: auto;
            scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.25) transparent; color-scheme: dark;
            padding: 16px; border-radius: 18px;
            background: rgba(20, 20, 25, 0.92); color: #fff; font-family: ${FONT};
            border: 1px solid rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
            display: flex; flex-direction: column; gap: 12px;
            opacity: 0; transform: translateY(8px);
            transition: opacity 0.2s ease, transform 0.2s ease;
        `,
      { id: PANEL_ID },
      [
        h('div', null, null, [
          h(
            'div',
            'display: flex; align-items: center; justify-content: space-between;',
            null,
            [
              h(
                'div',
                'font-size: 16px; font-weight: 700; letter-spacing: -0.2px;',
                { textContent: 'Sleep timer' },
              ),
              ctl.enabled.el,
            ],
          ),
          ctl.status,
        ]),
        h('div', 'height: 1px; background: rgba(255, 255, 255, 0.08);'),
        makeRow(
          'Stop after this episode',
          'Stops at the end instead of playing the next one',
          ctl.stop.el,
        ),
        h('div', 'height: 1px; background: rgba(255, 255, 255, 0.08);'),
        ctl.body,
        h(
          'div',
          'display: flex; align-items: center; justify-content: space-between;',
          null,
          [reset, done],
        ),
      ],
    );
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Sleep timer settings');
    return { root, ctl };
  }

  function openPanel() {
    if (panel || !chip) {
      return;
    }
    showChip();
    panel = buildPanel();
    document.body.appendChild(panel.root);
    const rect = chip.getBoundingClientRect();
    const bottom = Math.round(window.innerHeight - rect.top + 10);
    panel.root.style.bottom = `${bottom}px`;
    panel.root.style.maxHeight = `${Math.max(240, window.innerHeight - bottom - 16)}px`; // use the room above the chip
    renderPanel();
    updatePanelStatus(document.querySelector('video'));
    const opened = panel;
    requestAnimationFrame(() => {
      opened.root.style.opacity = '1';
      opened.root.style.transform = 'translateY(0)';
    });
  }

  function closePanel() {
    if (!panel) {
      return;
    }
    panel.root.remove();
    panel = null;
  }

  function togglePanel() {
    if (panel) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function renderPanel() {
    if (!panel) {
      return;
    }
    const ctl = panel.ctl;
    ctl.enabled.set(cfg.enabled);
    ctl.countdown.set(cfg.showCountdown);
    ctl.ignore.set(cfg.ignoreInput);
    ctl.stop.set(stopAfterEpisode);
    ctl.idleRow.hintEl.textContent = cfg.ignoreInput
      ? 'Of playback time'
      : 'With no mouse or keyboard input';
    ctl.corners.forEach((c) => styleChoice(c.btn, c.value === cfg.cornerTimer));
    if (document.activeElement !== ctl.idle.input) {
      ctl.idle.input.value = String(cfg.idleMinutes);
    }
    if (document.activeElement !== ctl.seconds.input) {
      ctl.seconds.input.value = String(cfg.promptSeconds);
    }
    ctl.presets.forEach((p) =>
      styleChoice(p.btn, p.minutes === cfg.idleMinutes),
    );
    ctl.actions.forEach((a) => styleChoice(a.btn, a.value === cfg.onTimeout));
    ctl.body.style.opacity = cfg.enabled ? '1' : '0.45';
  }

  function updatePanelStatus(video) {
    if (!panel) {
      return;
    }
    let text;
    if (!cfg.enabled) {
      text = 'The timer is off. Playback will not be paused automatically.';
    } else if (!video || video.paused) {
      text = 'Playback is paused, so the timer is waiting.';
    } else {
      const remaining = remainingMs();
      text = cfg.ignoreInput
        ? `Asks if you are still watching after ${formatDuration(remaining)} more of playback. Mouse and keyboard are ignored.`
        : `Asks if you are still watching in ${formatDuration(remaining)} unless you touch something.`;
    }
    panel.ctl.status.textContent = text;
  }

  // ------------------------------------------------------------------ activity tracking and the main loop

  function onActivity(e) {
    lastActivity = Date.now();
    if (
      e.type === 'mousedown' ||
      e.type === 'pointerdown' ||
      e.type === 'touchstart'
    ) {
      lastIntentAt = lastActivity;
    }
    if (!POINTER_EVENTS.includes(e.type)) {
      return;
    }
    chipHideAt = lastActivity + CHIP_ACTIVE_MS;
    const onChipOrPanel =
      (chip && chip.contains(e.target)) ||
      (panel && panel.root.contains(e.target));
    if (e.type === 'pointerdown' && panel && !onChipOrPanel) {
      closePanel();
    }
    if (!prompt) {
      showChip();
    }
  }

  // Capture phase, so Stremio's own shortcuts never see keys meant for the prompt or the panel.
  function onKeyDown(e) {
    lastActivity = Date.now();
    lastIntentAt = lastActivity;
    if (prompt) {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        confirmStillWatching();
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    } else if (panel && panel.root.contains(e.target)) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
      e.stopImmediatePropagation();
    }
  }

  function tick() {
    const now = Date.now();
    const step = Math.min(now - lastTickAt, MAX_TICK_STEP_MS);
    lastTickAt = now;
    const video = document.querySelector('video');
    if (video) {
      lastVideoAt = now;
    } else if (now - lastVideoAt > PLAYER_GONE_RESET_MS) {
      restartTimer(); // left the player for a while: start fresh next time
      if (stopAfterEpisode) {
        setStopAfter(false); // and a leftover "stop after this episode" no longer applies
      }
    }
    syncChip(video);
    checkStopAfterEpisode();
    if (video && !video.paused && holdingPause()) {
      video.pause(); // the next episode tried to autoplay after we stopped
    }

    if (prompt) {
      hideCorner();
      if (!video) {
        // the player was closed some other way
        restartTimer();
        closePrompt();
        return;
      }
      if (!video.paused) {
        // something resumed playback behind the prompt
        video.pause();
      }
      if (deadline - now <= 0) {
        onPromptExpired();
      } else {
        updateCountdown();
      }
      return;
    }

    const playing = !!video && !video.paused && !video.ended;
    if (playing) {
      playedMs += step;
    }
    updateCorner(video, playing);
    if (cfg.enabled && playing && remainingMs() <= 0) {
      showPrompt(video);
    }
  }

  function teardown() {
    clearInterval(timer);
    ACTIVITY_EVENTS.forEach((type) =>
      window.removeEventListener(type, onActivity, LISTENER_OPTIONS),
    );
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('ended', onVideoEnded, true);
    window.removeEventListener('play', onVideoPlay, true);
    window.removeEventListener('hashchange', checkStopAfterEpisode);
    unmountChip();
    removeCorner();
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.remove();
    }
    prompt = null;
    if (window.__sleepTimerTeardown === teardown) {
      delete window.__sleepTimerTeardown;
    }
  }

  ACTIVITY_EVENTS.forEach((type) =>
    window.addEventListener(type, onActivity, LISTENER_OPTIONS),
  );
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('ended', onVideoEnded, true); // media events do not bubble, so listen in the capture phase
  window.addEventListener('play', onVideoPlay, true);
  window.addEventListener('hashchange', checkStopAfterEpisode);
  const timer = setInterval(tick, TICK_MS);
  window.__sleepTimerTeardown = teardown;

  initSettings().catch((err) =>
    log('error', `Settings setup failed: ${(err && err.message) || err}`),
  );
})();
