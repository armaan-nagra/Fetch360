# Fetch360

**Fetch360** is a browser extension designed for University of Warwick students, enabling them to easily download any lecture from Echo360. 

## Current Stage

Fetch 360 is published on the Chrome Web Store and you can download it [here](https://chromewebstore.google.com/detail/fetch-360/koaindoledjjcpohloicpdmamncepcjp?hl=en)

Currently working on an implementation to allow students using Panopto to download lectures and also to convert to other popular browsers such as Safari, Microsoft Edge etc... So stay tuned!


## Demo

Click [here](https://youtu.be/E79fH6qeGE8?si=zfhObuWZ-40ZRtJE) for a demo.

## Architecture

- Extension UI: `popup/popup.html`, `popup/popup.css`, `popup/popup.js`
- Background service worker: `service-worker.js`
- WASM media tooling: `libs/ffmpeg.min.js`, `libs/ffmpeg-core.*`

Flow:
- The service worker observes Echo360 network requests and stores the latest audio/video segment URLs per `tabId`.
- The popup asks the service worker for the latest media for the active tab via messaging.
- The popup downloads the audio/video streams, shows combined progress, uses `ffmpeg.wasm` to mux, and triggers a file download.

## Permissions rationale

- `activeTab`: read the active tab ID to request media and title.
- `scripting`: inject a small script to read `document.title` for naming.
- `webRequest`: observe Echo360 media requests to capture stream URLs.
- `storage`: cache last-known media URLs per tab and survive worker restarts.

`host_permissions` is limited to `*://content.echo360.org.uk/*` for least-privilege.

## Security and CSP

Manifest V3 service worker runs in an isolated context. Extension pages allow `'wasm-unsafe-eval'` to enable `ffmpeg.wasm`. No remote code is executed.

## Developer notes

- Media tracking per tab: stored in-memory with a mirrored `chrome.storage.local` entry keyed as `media:<tabId>`.
- Popup communicates with the background via `chrome.runtime.sendMessage({ type: 'getLatestMedia', tabId })`.
- If `Content-Length` is missing, the progress bar falls back to an indeterminate animation and shows downloaded bytes.

## Building and testing locally

1. Open `chrome://extensions` and enable Developer mode.
2. Click "Load unpacked" and select this folder.
3. Open an Echo360 lecture, start playback (to trigger media requests), then click the extension and press Download.

## Roadmap

- Add Panopto support and additional host permissions behind a toggle.
- Add filename template options in a settings page.
- Port to other Chromium-based browsers and Safari (Manifest adjustments).
