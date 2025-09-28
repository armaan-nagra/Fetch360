const { createFFmpeg, fetchFile } = FFmpeg;

const ffmpeg = createFFmpeg({
    corePath: chrome.runtime.getURL("libs/ffmpeg-core.js"),
    log: true,
    mainName: 'main'
});

function formatBytes(bytes) { //format the bytes to a readable format
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
    let loadedSize = 0; //total size of the files downloaded in bytes

    if (progressElement) {
        progressElement.style.display = "block";
        progressElement.value = 0;
    }

    const sizes = await Promise.all( //both requests are made in parallel
        urls.map(async (url) => {
            try {
                const head = await fetch(url, { method: "HEAD" });
                const len = head.headers.get("Content-Length"); // Content-Length is the length of the content in the response (HTTP response header, that tells you the length of the content in the response in bytes)
                const size = len ? parseInt(len, 10) : 0; //convert the length to an integer
                if (!len) knownTotal = false;
                return size;
            } catch (_) {
                knownTotal = false;
                return 0;
            }
        })
    );
    totalSize = sizes.reduce((a, b) => a + b, 0); //sum the sizes of the files

    const blobs = await Promise.all(
        urls.map(async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);

            const reader = response.body.getReader();
            const chunks = []; //an array of Uint8Array pieces/chunks
            while (true) {
                //.read() stream reading function, yields next chunk of response bytes from the stream
                const { done, value } = await reader.read(); //value is a Uint8Array containing next chunk of response bytes from the stream
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
            return new Blob(chunks); //concatenate the chunks to form the final blob
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

    //Blob isn't directly readable by ffmpeg, so we need to convert it to a buffer
    const audioBuffer = new Uint8Array(await audioBlob.arrayBuffer());
    const videoBuffer = new Uint8Array(await videoBlob.arrayBuffer());

    status.textContent = "Writing to memory...";
    //write a file into FFmpeg's in-memory filesystem
    ffmpeg.FS("writeFile", "audio.mp4", await fetchFile(audioBuffer));
    ffmpeg.FS("writeFile", "video.mp4", await fetchFile(videoBuffer));

    status.textContent = "Merging audio and video...";
    await ffmpeg.run(...commandList);

    const data = ffmpeg.FS("readFile", outputFileName); //read the merged file from the in-memory filesystem
    const blob = new Blob([data.buffer]); //convert the buffer to a blob
    downloadFile(blob, outputFileName); //download the merged file

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
            (results) => { //results is an array of results from the script execution
                if (chrome.runtime.lastError) { //error placeholder by chrome if callback-based extension API fails
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
			resolve({ audioUrl: null, videoUrl: null });
        });
    });
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9]+/g, "-");//add a - to replace any non-alphanumeric characters
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