# Stremio Enhanced plugins: Sleep Timer and Watch Stats

Two small, offline plugins for [Stremio Enhanced](https://github.com/REVENGE977/stremio-enhanced), the Electron wrapper that loads Stremio Web and lets you drop in plugins.

| Plugin | What it does |
| --- | --- |
| **Sleep Timer** | Pauses playback and asks "Are you still watching?" so you don't leave a show running all night. Settings live in a gear button inside the player. Based on [dotcme's original](https://github.com/dotcme/stremio-sleep-timer/). |
| **Watch Stats** | Adds a **Stats** button next to *Continue watching* on the Board. It lists every film and episode you have watched, with watch counts, time watched and the date you last watched. It tracks times and counts itself and keeps Stremio's own totals behind a toggle, as they may not be accurate. |

Both plugins keep everything on your computer. They make no network requests, never change your Stremio account or profile settings, and never read your login key.

> **Requires Stremio Enhanced.** These plugins use Stremio Enhanced's plugin loader, so they don't run in the official Stremio app or in a normal browser. They were built and tested on Stremio Enhanced **v1.2.0 on macOS**. The Windows and Linux folder paths below come from Stremio Enhanced's source but haven't been tested.

---

## What's in this repo

```
stremio-plugins/
├── timer/
│   ├── sleeptimer.plugin.js      <- the plugin
│   └── sleeptimer.plugin.json    <- its saved settings (defaults)
└── watch-stats/
    ├── watchstats.plugin.js      <- the plugin
    └── watchstats.plugin.json    <- its saved data (starts empty)
```

The files are in folders to keep the repo tidy, but **Stremio Enhanced only looks for plugins directly inside its `plugins` folder**. You need to copy the files out of `timer/` and `watch-stats/`, not the folders themselves. The install steps below show how.

---

## Install

### 1. Get the files

Download this repo as a ZIP (**Code → Download ZIP**) and unzip it, or clone it:

```bash
git clone https://github.com/CameronHowsonn/stremio-enhanced-plugins.git
```

### 2. Open Stremio Enhanced's plugins folder

The quickest way: in Stremio Enhanced go to **Settings → Enhanced → Plugins** and click **Open Plugins Folder**.

Or go there yourself:

| OS | Plugins folder |
| --- | --- |
| macOS | `~/Library/Application Support/stremio-enhanced/plugins` |
| Windows | `%APPDATA%\stremio-enhanced\plugins` |
| Linux | `~/.config/stremio-enhanced/plugins` |

### 3. Copy the files in

Copy the four files from the subfolders **into the plugins folder itself**, with no subfolders. Afterwards it should look like this:

```
plugins/
├── sleeptimer.plugin.js
├── sleeptimer.plugin.json
├── watchstats.plugin.js
└── watchstats.plugin.json
```

You only need the two `.plugin.js` files. The `.plugin.json` files hold each plugin's saved settings and data, and Stremio Enhanced creates them automatically if they're missing. Don't overwrite an existing `.plugin.json` if you already use a plugin, or you'll replace your saved settings (and, for Watch Stats, your history).

### 4. Turn them on

1. Go to **Settings → Enhanced → Plugins**.
2. Switch on **Sleep Timer** and **Watch Stats**.
3. Click the **reload** link that appears, or press `Ctrl+R`.

That's it. Both plugins start working straight away with sensible defaults.

---

## Sleep Timer

Pauses playback after a period with no activity, asks whether you're still watching, and, if nobody answers, leaves the player. It's built for falling asleep to a show.

*Based on [stremio-sleep-timer](https://github.com/dotcme/stremio-sleep-timer/) by [dotcme](https://github.com/dotcme), modified and extended. See [Credits](#credits).*

**How it works**

- You watch as normal. If nothing happens for **90 minutes** (the default), playback pauses and an "Are you still watching?" prompt appears.
- The prompt waits **2 minutes**. Press **Enter** or **Space** (or click) to keep watching and the timer starts over.
- If nobody answers, it goes **back** to where you were, goes **Home**, or just stays paused, whichever you've chosen.

**The in-player gear button.** While a video is open, a small gear chip appears at the bottom left. Click it to open the settings panel:

- **Enabled** on/off.
- **Minutes before it asks**: type a number (1 to 1440) or use a preset: 30, 45, 60, 90, 120, 180.
- **Ignore mouse and keyboard**: counts playback time only, so nudging the volume or moving the mouse never restarts the countdown. This turns it into a plain "stop in N minutes" timer.
- **Top-right countdown**: *Smart* (shows for the last 5 minutes, or always when ignoring input), *Always*, or *Off*.
- **When it stops**: Back, Home or Just pause.
- **Stop after this episode**: a one-off switch. When the current episode ends, it stops and leaves instead of playing the next one. It then switches itself off, so tomorrow's first episode plays normally, and it doesn't touch Stremio's own autoplay setting.
- **Reset to defaults.**

Everything is also available under **Settings → Enhanced → Plugins → Sleep Timer**. Changes apply immediately and are remembered.

**Defaults**

| Setting | Default |
| --- | --- |
| Enabled | on |
| Minutes before it asks | 90 |
| Prompt wait | 120 seconds |
| Ignore mouse and keyboard | off |
| When it stops | Back |
| Top-right countdown | Smart |

---

## Watch Stats

A stats page for everything you've watched.

**Using it.** Open the **Board** and click **Stats** beside the *Continue watching* heading. (If Stremio's layout ever hides that heading, the button falls back to a small floating button in the corner.) Press **Esc** or click outside the panel to close it.

- **Films** and **Shows** tabs, plus a search box and sorting by *Last watched*, *A to Z*, *Most time* or *Most watched*.
- **Shows work like an accordion.** Click one to see every episode with its watch count, time watched and last-watched date. Each show also shows a combined total.
- **Finished only** hides things you started but didn't finish.
- A compact layout that fits on a small laptop screen.

**Where the numbers come from.** Stremio's library knows *what* you've watched, but it doesn't keep per-episode counts, times or dates. It does keep running totals for each title, but **there's no way to check that those totals are accurate**, and in testing they came out implausibly high (thousands of hours for a single library). So Watch Stats doesn't trust them, and **by default it only shows what it has measured itself**:

- The **list** of films and shows comes from your Stremio library.
- The **counts, times and last-watched dates** are measured by the plugin as you watch, starting from the day you install it. Time only counts when the video is really playing: pausing and skipping around don't add to it. A play counts once you've watched at least 70% of the runtime, or reached the end after watching at least half.
- Things you watched *before* installing still appear in the list, but with no episode detail and no tracked time.
- Live TV, channels and "other" types are ignored.

**Stremio's own totals are behind a toggle.** Tick **Include Stremio's older totals** in the Stats panel to add the numbers Stremio has stored (they're labelled *Stremio's own total, unchecked*). It's off by default because they may be wrong. Untick it to go back to tracked-only figures. Because tracking starts at install, the tracked totals will look small at first and grow the more you watch.

**Where the data is stored.** The history is written to **two places**, so losing one doesn't lose your stats:

1. `watchstats.plugin.json` in the plugins folder, and
2. the app's own browser storage (`localStorage` key `watchstats.history`).

On every start the plugin merges the two and repairs whichever one is missing.

---

## Updating

Copy the new `.plugin.js` over the old one and reload. **Leave your existing `.plugin.json` files alone**, because they hold your settings and history.

## Uninstalling

Switch the plugin off in **Settings → Enhanced → Plugins**, then delete its files from the plugins folder. Deleting `watchstats.plugin.json` removes the saved history file. The second copy stays in the app's browser storage until you clear it.

---

## Troubleshooting

- **I don't see the plugins in Settings.** Check the `.plugin.js` files are directly inside the `plugins` folder (not in a subfolder), and reload.
- **The gear button doesn't appear.** It only shows in the video player, and only if Sleep Timer is switched on. Reload after enabling.
- **No Stats button on the Board.** Make sure Watch Stats is switched on and you've reloaded. The button only shows on the Board (the home screen).
- **Settings for a plugin look stuck after an update.** Quit and reopen Stremio Enhanced. It remembers a plugin's settings page until it restarts.

---

## Credits

- **Sleep Timer** is based on [stremio-sleep-timer](https://github.com/dotcme/stremio-sleep-timer/) by **[dotcme](https://github.com/dotcme)**, which pauses playback after 90 minutes of inactivity and asks "Are you still watching?". This version was modified and extended (settings panel, fixed-time mode, countdown, stop after this episode), but the original idea and starting point are theirs. Please go and give their repo a star.
- **Watch Stats** was written from scratch for this repo.
- Both plugins are built for [Stremio Enhanced](https://github.com/REVENGE977/stremio-enhanced) by REVENGE977.

This is a community project and isn't affiliated with Stremio or Stremio Enhanced.
