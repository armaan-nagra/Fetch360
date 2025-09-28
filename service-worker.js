// Service worker (MV3) - tracks latest audio/video URLs per tab and exposes a messaging API

/**
 * In-memory map: tabId -> { audioUrl?: string, videoUrl?: string, updatedAt: number }
 * We also mirror to storage for resilience across SW restarts.
 */
const tabIdToMedia = new Map();

function persistTabMedia(tabId) {
    const key = `media:${tabId}`;
    const media = tabIdToMedia.get(tabId) || null;
    chrome.storage.local.set({ [key]: media });
}

function removePersistedTabMedia(tabId) {
    const key = `media:${tabId}`;
    chrome.storage.local.remove([key]);
}

function updateTabMedia(tabId, kind, url) {
    if (typeof tabId !== "number" || tabId < 0) return;
    const current = tabIdToMedia.get(tabId) || { updatedAt: 0 };
    const newEntry = {
        audioUrl: kind === "audio" ? url : current.audioUrl,
        videoUrl: kind === "video" ? url : current.videoUrl,
        updatedAt: Date.now()
    };
    tabIdToMedia.set(tabId, newEntry);
    persistTabMedia(tabId);
    console.log(`[Fetch360] Updated ${kind} for tab ${tabId}: ${url}`);
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabIdToMedia.has(tabId)) {
        tabIdToMedia.delete(tabId);
        removePersistedTabMedia(tabId);
    }
});

function handleAudio(details) {
    updateTabMedia(details.tabId, "audio", details.url);
}

function handleVideo(details) {
    updateTabMedia(details.tabId, "video", details.url);
}

chrome.webRequest.onCompleted.addListener(
    handleAudio,
    { urls: ["*://content.echo360.org.uk/*s0q1.m4s*"], types: ["xmlhttprequest", "media"] }
);

chrome.webRequest.onCompleted.addListener(
    handleVideo,
    { urls: ["*://content.echo360.org.uk/*s1q1.m4s*"], types: ["xmlhttprequest", "media"] }
);

// Messaging API for popup to request latest media for a given tabId
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "getLatestMedia") {
        const tabId = message.tabId;
        const media = tabIdToMedia.get(tabId);
        if (media && media.audioUrl && media.videoUrl) {
            sendResponse({ ok: true, media });
            return true;
        }
        // Fallback to persisted storage if SW restarted
        const key = `media:${tabId}`;
        chrome.storage.local.get([key], (res) => { //async function hence why we need to keep channel open 
            const stored = res[key] || null;
            if (stored && stored.audioUrl && stored.videoUrl) {
                tabIdToMedia.set(tabId, stored);
                sendResponse({ ok: true, media: stored });
            } else {
                sendResponse({ ok: false, error: "No media captured for this tab yet." });
            }
        });
        return true; // indicate async response needed as chrome.storage.local.get is async and channel need to remain open
    }
});

