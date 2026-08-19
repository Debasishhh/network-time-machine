# Network Time Machine

Browser extension (Manifest V3) that keeps an always-on log of network requests. No need to have DevTools open — check back and see what happened over the last few minutes.

## Why

Bug shows up, DevTools wasn't open, network tab shows nothing. This extension runs in background, buffers requests continuously, so you can trace calls after the fact.

## Features

- Always-on capture via `webRequest`, no DevTools required
- Filter by URL/domain/status, tab (current/all), request type (XHR, fetch, script, CSS, image, document, other)
- Time range window: last 1 / 5 / 15 / 30 min
- Errors-only view, error count badge
- Click request for detail view
- Configurable retention window (1–120 min)
- Pause/resume capture, clear log

## Install (unpacked)

1. Go to `chrome://extensions` (or `edge://extensions`)
2. Enable Developer mode
3. Click "Load unpacked", select this folder
4. Pin extension, click icon to open popup

## Files

- `manifest.json` — MV3 manifest, permissions (`webRequest`, `storage`, `tabs`, `alarms`), all-URLs host access
- `background.js` — service worker, captures and buffers requests
- `popup.html` / `popup.css` / `popup.js` — popup UI: filters, list, detail view, retention control
