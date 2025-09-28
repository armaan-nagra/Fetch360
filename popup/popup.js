const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({
    corePath: chrome.runtime.getURL("libs/ffmpeg-core.js"),
    log: true,
    mainName: 'main'
});

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(1)} ${units[i]}`;
}

async function fetchWithCombinedProgress(urls, progressElement, statusText) {
    let totalSize = 0;
    let knownTotal = true;
    let loadedSize = 0;

    if (progressElement) {
        progressElement.style.display = "block";
        progressElement.value = 0;
    }

    const sizes = await Promise.all(
        urls.map(async (url) => {
            try {
                const head = await fetch(url, { method: "HEAD" });
                const len = head.headers.get("Content-Length");
                const size = len ? parseInt(len, 10) : 0;
                if (!len) knownTotal = false;
                return size;
            } catch (_) {
                knownTotal = false;
                return 0;
            }
        })
    );
    totalSize = sizes.reduce((a, b) => a + b, 0);

    const blobs = await Promise.all(
        urls.map(async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

            const reader = response.body.getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loadedSize += value.length;

                if (progressElement) {
                    if (knownTotal && totalSize > 0) {
                        progressElement.value = (loadedSize / totalSize) * 100;
                    } else {
                        // Indeterminate fallback: pulse between 15% and 85%
                        const t = Date.now() / 500;
                        progressElement.value = 50 + 35 * Math.sin(t);
                    }
                }
                if (statusText) {
                    if (knownTotal && totalSize > 0) {
                        statusText.textContent = `Downloading... ${(loadedSize / totalSize * 100).toFixed(1)}%`;
                    } else {
                        statusText.textContent = `Downloading... ${formatBytes(loadedSize)}`;
                    }
                }
            }
            return new Blob(chunks);
        })
    );

    if (progressElement) {
        progressElement.style.display = "none";
        progressElement.value = 0;
    }

    return blobs;
}

async function runFFmpeg(outputFileName, commandStr, audioUrl, videoUrl, status, progressBar) {
    if (!audioUrl || !videoUrl) {
        throw new Error("Missing media URLs. Start playing the lecture, then try again.");
    }

    if (ffmpeg.isLoaded()) {
        await ffmpeg.exit();
    }
    await ffmpeg.load();

    const commandList = commandStr.split(" ");
    if (commandList.shift() !== "ffmpeg") {
        throw new Error("Command must start with 'ffmpeg'");
    }

    status.textContent = "Fetching files...";
    const [audioBlob, videoBlob] = await fetchWithCombinedProgress(
        [audioUrl, videoUrl],
        progressBar,
        status
    );

    const audioBuffer = new Uint8Array(await audioBlob.arrayBuffer());
    const videoBuffer = new Uint8Array(await videoBlob.arrayBuffer());

    status.textContent = "Writing to memory...";
    ffmpeg.FS("writeFile", "audio.mp4", await fetchFile(audioBuffer));
    ffmpeg.FS("writeFile", "video.mp4", await fetchFile(videoBuffer));

    status.textContent = "Merging audio and video...";
    await ffmpeg.run(...commandList);

    const data = ffmpeg.FS("readFile", outputFileName);
    const blob = new Blob([data.buffer]);
    downloadFile(blob, outputFileName);

    status.textContent = "Download complete!";
    progressBar.value = 0;
}

function downloadFile(blob, fileName) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
}

async function getActiveTabId() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || tabs.length === 0) {
                reject("No active tab found.");
                return;
            }
            resolve(tabs[0].id);
        });
    });
}

async function getTitleFromPage() {
    const activeTabId = await getActiveTabId();
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
            {
                target: { tabId: activeTabId, allFrames: false },
                func: () => document.title || "Untitled Page",
            },
            (results) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError.message);
                } else if (results && results[0] && results[0].result) {
                    resolve(results[0].result);
                } else {
                    reject("Failed to retrieve title");
                }
            }
        );
    });
}

async function getLatestMediaForActiveTab() {
    const tabId = await getActiveTabId();
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "getLatestMedia", tabId }, (resp) => {
            if (resp && resp.ok && resp.media) {
                resolve(resp.media);
                return;
            }
            // Fallback to old storage keys for backward compatibility
            chrome.storage.local.get(["latestAudio", "latestVideo"], (res) => {
                resolve({ audioUrl: res.latestAudio || null, videoUrl: res.latestVideo || null });
            });
        });
    });
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9]+/g, "-");
}

function setButtonDisabled(disabled) {
    const btn = document.getElementById("download");
    if (btn) {
        btn.disabled = disabled;
        btn.setAttribute("aria-busy", String(disabled));
    }
}

document.getElementById("download").addEventListener("click", async () => {
    const status = document.getElementById("status");
    const progressBar = document.getElementById("progress-bar");
    setButtonDisabled(true);
    try {
        status.textContent = "Preparing...";
        const pageTitle = await getTitleFromPage().catch(() => "Unknown Title");
        const media = await getLatestMediaForActiveTab();
        const outputFileName = `${sanitizeFilename(pageTitle)}.mp4`;

        await runFFmpeg(
            outputFileName,
            `ffmpeg -i video.mp4 -i audio.mp4 -c:v copy -c:a copy ${outputFileName}`,
            media.audioUrl,
            media.videoUrl,
            status,
            progressBar
        );
    } catch (err) {
        status.textContent = String(err || "Failed");
    } finally {
        setButtonDisabled(false);
    }
});