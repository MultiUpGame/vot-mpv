#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync, spawn } = require("child_process");

const SHARE_DIR  = path.join(os.homedir(), ".local", "share", "vot-mpv");
const CACHE_DIR  = path.join(os.homedir(), ".cache", "vot");
const VIDEOS_DIR = path.join(os.homedir(), "Videos", "vot");
const LIBRARY    = path.join(SHARE_DIR, "library.json");
const VOT_SCRIPT = path.join(SHARE_DIR, "vot-translate.js");
const CONF_PATH  = path.join(os.homedir(), ".config", "mpv", "script-opts", "vot.conf");
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

// ── Config & quality ─────────────────────────────────────────────────────────

function readConf() {
  try {
    return Object.fromEntries(
      fs.readFileSync(CONF_PATH, "utf8").split("\n")
        .filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
        .filter(([k]) => k)
    );
  } catch { return {}; }
}

function ytdlFormat(quality) {
  if (!quality || quality === "best") return "bestvideo+bestaudio/best";
  return `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;
}

function pickQuality(defaultQ) {
  const options = [
    `480 — легко (~150-300 МБ/год відео)`,
    `720 — збалансовано (~500 МБ/год відео)`,
    `1080 — якісно (~1-2 ГБ/год відео)`,
    `2160 — 4K максимум (~5-8 ГБ/год відео)`,
    `best — найкраще доступне`,
  ].join("\n");

  const result = spawnSync("fzf", [
    `--prompt=Якість > `,
    `--height=30%`,
    `--border=rounded`,
    `--header=Вибери якість для завантаження (за замовч. ${defaultQ}p)`,
    `--no-multi`,
  ], { input: options, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });

  if (result.status !== 0 || !result.stdout.trim()) return defaultQ;
  return result.stdout.trim().split(" ")[0];
}

// ── Library ──────────────────────────────────────────────────────────────────

function loadLib() {
  try { return JSON.parse(fs.readFileSync(LIBRARY, "utf8")); }
  catch { return { videos: [] }; }
}

function saveLib(lib) {
  fs.mkdirSync(SHARE_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY, JSON.stringify(lib, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getVideoId(url) {
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function hasCachedTranslation(id) {
  try {
    const stat = fs.statSync(path.join(CACHE_DIR, id + ".mp3"));
    return Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS;
  } catch { return false; }
}

function getTitle(url) {
  try {
    return execFileSync("yt-dlp", ["--print", "title", "--no-playlist", url], {
      timeout: 20000, encoding: "utf8",
    }).trim() || url;
  } catch { return url; }
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const I = { online: "🌐", local: "💾", ok: "✓", fail: "✗", none: "—" };

function icons(v) {
  return {
    src:   v.videoPath ? I.local : I.online,
    trans: hasCachedTranslation(v.id) ? I.ok : v.translationFailed ? I.fail : I.none,
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdAdd(url) {
  const id = getVideoId(url);
  if (!id) { die("Не вдалось знайти videoId в URL: " + url); }

  const lib = loadLib();
  if (lib.videos.find(v => v.id === id)) {
    console.log("Вже є в бібліотеці: " + id);
    return;
  }

  process.stdout.write("Отримуємо назву... ");
  const title = getTitle(url);
  console.log(title);

  lib.videos.push({ id, url, title, added: new Date().toISOString(), translationFailed: false, videoPath: null });
  saveLib(lib);
  console.log("✓ Додано");
}

function cmdList() {
  const lib = loadLib();
  if (!lib.videos.length) {
    console.log("Бібліотека порожня. Додайте відео:\n  vot add <youtube-url>");
    return;
  }

  const maxTitle = Math.min(process.stdout.columns - 26 || 60, 70);
  console.log("\n  Src  Пер  ID            Назва");
  console.log("  " + "─".repeat(maxTitle + 22));
  for (const v of lib.videos) {
    const { src, trans } = icons(v);
    const title = v.title.length > maxTitle ? v.title.slice(0, maxTitle - 1) + "…" : v.title;
    console.log(`  ${src}   ${trans}   ${v.id}  ${title}`);
  }
  console.log();
  console.log("  Легенда: 🌐 онлайн  💾 локальне  ✓ переклад є  ✗ провал  — немає\n");
}

function buildMpvArgs(target, quality) {
  const args = [];
  if (target.startsWith("http")) {
    args.push(`--ytdl-format=${ytdlFormat(quality)}`);
  }
  args.push(target);
  return args;
}

function cmdPick() {
  const lib = loadLib();
  if (!lib.videos.length) { die("Бібліотека порожня."); }

  const lines = lib.videos.map(v => {
    const { src, trans } = icons(v);
    return `${src} ${trans}\t${v.id}\t${v.title}`;
  }).join("\n");

  const result = spawnSync("fzf", [
    "--delimiter=\t",
    "--with-nth=1,3",
    "--prompt=vot> ",
    "--height=50%",
    "--border=rounded",
    "--preview-window=hidden",
  ], { input: lines, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });

  if (result.status !== 0 || !result.stdout.trim()) process.exit(0);

  const fields = result.stdout.trim().split("\t");
  const id = fields[1];
  const video = lib.videos.find(v => v.id === id);
  if (!video) { die("Не знайдено відео: " + id); }

  const target = video.videoPath && fs.existsSync(video.videoPath) ? video.videoPath : video.url;
  const quality = readConf().quality || "1080";
  spawnSync("mpv", buildMpvArgs(target, quality), { stdio: "inherit" });
}

function cmdPlay(id, quality) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) { die("Не знайдено: " + id); }
  const target = video.videoPath && fs.existsSync(video.videoPath) ? video.videoPath : video.url;
  const q = quality || readConf().quality || "1080";
  spawnSync("mpv", buildMpvArgs(target, q), { stdio: "inherit" });
}

function cmdRemove(id) {
  const lib = loadLib();
  const idx = lib.videos.findIndex(v => v.id === id);
  if (idx === -1) { die("Не знайдено: " + id); }
  const [removed] = lib.videos.splice(idx, 1);
  saveLib(lib);
  console.log("✓ Видалено: " + removed.title);
}

function fetchOne(video) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VOT_SCRIPT, "--prefetch", video.url], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, FETCH_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function cmdFetch(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) { die("Не знайдено: " + id); }

  process.stdout.write(`Перекладаємо: ${video.title}\n`);
  const ok = await fetchOne(video);
  const entry = lib.videos.find(v => v.id === id);
  if (entry) entry.translationFailed = !ok;
  saveLib(lib);
  console.log(ok ? "✓ Готово" : "✗ Провал");
}

async function cmdFetchAll() {
  const lib = loadLib();
  const toFetch = lib.videos.filter(v => !hasCachedTranslation(v.id));

  if (!toFetch.length) {
    console.log("Всі відео вже мають переклад.");
    return;
  }

  console.log(`\nПерекладаємо ${toFetch.length} відео (макс 5хв на кожне)...\n`);

  for (let i = 0; i < toFetch.length; i++) {
    const v = toFetch[i];
    const prefix = `[${i + 1}/${toFetch.length}]`;
    process.stdout.write(`${prefix} ${v.title}\n         → `);

    const ok = await fetchOne(v);
    console.log(ok ? "✓" : "✗ провал, пропускаємо");

    const entry = lib.videos.find(e => e.id === v.id);
    if (entry) entry.translationFailed = !ok;
    saveLib(lib);
  }

  const failed = lib.videos.filter(v => v.translationFailed).length;
  console.log(`\nГотово. ${toFetch.length - failed} успішно${failed ? ", " + failed + " провалів (✗ в списку)" : ""}.`);
}

function cmdDownload(id, quality) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) { die("Не знайдено: " + id); }

  if (video.videoPath && fs.existsSync(video.videoPath)) {
    console.log("Вже скачано: " + video.videoPath);
    return;
  }

  const defaultQ = readConf().quality || "1080";
  const q = quality || pickQuality(defaultQ);

  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const template = path.join(VIDEOS_DIR, "%(title)s [%(id)s].%(ext)s");

  console.log(`Завантажуємо: ${video.title} (${q === "best" ? "найкраще" : q + "p"})`);
  const result = spawnSync("yt-dlp", ["-f", ytdlFormat(q), "-o", template, video.url], { stdio: "inherit" });

  if (result.status !== 0) {
    console.error("✗ Помилка завантаження");
    process.exit(1);
  }

  const files = fs.readdirSync(VIDEOS_DIR).filter(f => f.includes("[" + video.id + "]"));
  if (files.length) {
    video.videoPath = path.join(VIDEOS_DIR, files[0]);
    saveLib(lib);
    console.log("✓ Збережено: " + video.videoPath);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function die(msg) { console.error(msg); process.exit(1); }

function help() {
  console.log(`
vot — менеджер відео з перекладом

  add <url>            Додати YouTube відео до бібліотеки
  list                 Показати всі відео зі статусами
  pick                 Вибрати через fzf → відкрити в mpv
  play <id> [quality]  Відкрити відео в mpv (quality: 480/720/1080/2160/best)
  remove <id>          Видалити з бібліотеки
  fetch <id>           Завантажити переклад для одного відео
  fetch --all          Завантажити переклади для всіх без перекладу
  download <id> [q]    Скачати відео (якість вибирається через меню або вкажи q)

Якість за замовчуванням береться з vot.conf (quality=1080).

Іконки в list:
  🌐 онлайн  💾 локальний файл
  ✓ переклад є  ✗ провал перекладу  — без перекладу
`);
}

const [,, cmd, arg, qualityArg] = process.argv;

(async () => {
  switch (cmd) {
    case "add":      if (!arg) die("Вкажіть URL"); cmdAdd(arg); break;
    case "list":     cmdList(); break;
    case "pick":     cmdPick(); break;
    case "play":     if (!arg) die("Вкажіть ID"); cmdPlay(arg, qualityArg); break;
    case "remove":   if (!arg) die("Вкажіть ID"); cmdRemove(arg); break;
    case "fetch":
      if (!arg) die("Вкажіть ID або --all");
      if (arg === "--all") await cmdFetchAll();
      else await cmdFetch(arg);
      break;
    case "download": if (!arg) die("Вкажіть ID"); cmdDownload(arg, qualityArg); break;
    default:         help(); break;
  }
})();
