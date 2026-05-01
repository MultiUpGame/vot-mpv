#!/usr/bin/env node
"use strict";

require("dns").setDefaultResultOrder("ipv4first");

const { VOTWorkerClient, videoData } = require("@vot.js/node");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawn } = require("child_process");

const WORKER_HOST = "vot-worker.eu.cc";
const S3_BASE = "https://vtrans.s3-private.mds.yandex.net/tts/prod/";
const AUDIO_PROXY = `https://${WORKER_HOST}/video-translation/audio-proxy/`;
const MAX_RETRIES = 60;
const CACHE_DIR = path.join(os.homedir(), ".cache", "vot");
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

async function fetchFn(url, options = {}) {
  const { timeout = 15000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function proxyAudioUrl(u) {
  return u.startsWith(S3_BASE) ? u.replace(S3_BASE, AUDIO_PROXY) : u;
}

async function downloadFile(fileUrl, destPath) {
  const resp = await fetchFn(fileUrl, { timeout: 120000 });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const buf = await resp.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buf));
}

function getVideoId(url) {
  const m = url.match(/[?&]v=([^&]+)/);
  return m ? m[1] : null;
}

function getCacheFile(videoId) {
  return videoId ? path.join(CACHE_DIR, videoId + ".mp3") : null;
}

function isCacheValid(cacheFile) {
  try {
    const stat = fs.statSync(cacheFile);
    return Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function getTranslationUrl(url, onStatus) {
  onStatus("Отримуємо дані відео...");
  const data = await videoData.getVideoData(url);
  if (!data) throw new Error("Не вдалось отримати дані відео");

  if (!data.duration) {
    try {
      const dur = execFileSync("/usr/bin/yt-dlp", ["--print", "duration", url], { timeout: 15000 }).toString().trim();
      const d = parseInt(dur, 10);
      if (d > 0) {
        data.duration = d;
        onStatus("Тривалість: " + d + "с. Перекладаємо...");
      }
    } catch (_) {}
  }

  const client = new VOTWorkerClient({ host: WORKER_HOST, fetchFn });

  for (let i = 0; i < MAX_RETRIES; i++) {
    onStatus("Переклад: спроба " + (i + 1) + "/" + MAX_RETRIES + "...");

    let result;
    try {
      result = await client.translateVideo({ videoData: data, responseLang: "ru" });
    } catch (e) {
      if (e.data?.shouldRetry === 1) {
        const wait = e.data?.remainingTime > 0 ? e.data.remainingTime : 30;
        onStatus("Сервер обробляє... ~" + wait + "с (спроба " + (i + 1) + "/" + MAX_RETRIES + ")");
        await sleep(wait * 1000);
        continue;
      }
      throw e;
    }

    if (result.translated && result.url) {
      return proxyAudioUrl(result.url);
    }

    const wait = result.remainingTime > 0 ? result.remainingTime : 30;
    onStatus("Яндекс перекладає... ще ~" + wait + "с (спроба " + (i + 1) + ")");
    await sleep(wait * 1000);
  }

  throw new Error("Таймаут перекладу");
}

// Mode: --download-cache <url> <dest>
if (process.argv[2] === "--download-cache") {
  downloadFile(process.argv[3], process.argv[4])
    .then(() => process.exit(0))
    .catch(() => process.exit(1));

// Mode: --prefetch <url>  (batch translation, waits for cache download)
} else if (process.argv[2] === "--prefetch") {
  prefetch(process.argv[3]);

} else {
  main();
}

async function prefetch(url) {
  const videoId = getVideoId(url);
  const cacheFile = getCacheFile(videoId);

  if (cacheFile && isCacheValid(cacheFile)) {
    process.stdout.write("cached\n");
    process.exit(0);
  }

  try {
    const audioUrl = await getTranslationUrl(url, (msg) => process.stderr.write("[VOT] " + msg + "\n"));

    if (cacheFile) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      await downloadFile(audioUrl, cacheFile);
    }

    process.stdout.write("ok\n");
    process.exit(0);
  } catch (e) {
    process.stderr.write("Error: " + e.message + "\n");
    process.exit(1);
  }
}

async function main() {
  const url = process.argv[2];
  const outFile = process.argv[3];
  const statusFile = outFile + ".status";

  if (!url || !outFile) {
    process.stderr.write("Usage: vot-translate.js <url> <output-file>\n");
    process.exit(1);
  }

  function status(msg) {
    fs.writeFileSync(statusFile, msg);
    process.stderr.write("[STATUS] " + msg + "\n");
  }

  try {
    const videoId = getVideoId(url);
    const cacheFile = getCacheFile(videoId);

    if (cacheFile && isCacheValid(cacheFile)) {
      try { fs.unlinkSync(statusFile); } catch (_) {}
      process.stdout.write(cacheFile + "\n");
      process.exit(0);
    }

    const audioUrl = await getTranslationUrl(url, status);

    try { fs.unlinkSync(statusFile); } catch (_) {}
    process.stdout.write(audioUrl + "\n");

    if (cacheFile) {
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const child = spawn(process.execPath, [__filename, "--download-cache", audioUrl, cacheFile], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch (_) {}
    }

    process.exit(0);
  } catch (e) {
    fs.writeFileSync(statusFile, "ПОМИЛКА: " + e.message);
    process.stderr.write("Error: " + e.message + "\n");
    process.exit(1);
  }
}
