#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync, spawn } = require("child_process");

const SHARE_DIR  = path.join(os.homedir(), ".local", "share", "vot-mpv");
const CACHE_DIR  = path.join(os.homedir(), ".cache", "vot");
const THUMB_DIR  = path.join(os.homedir(), ".cache", "vot", "thumbs");
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

// ── Library ───────────────────────────────────────────────────────────────────

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

function hasCachedTranslation(id, permanent = false) {
  try {
    const f = path.join(CACHE_DIR, id + ".mp3");
    const stat = fs.statSync(f);
    if (permanent) return true;
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

function thumbPath(id) {
  return path.join(THUMB_DIR, id + ".jpg");
}

async function downloadThumb(id) {
  const dest = thumbPath(id);
  if (fs.existsSync(dest)) return dest;
  try {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const res = await fetch(`https://img.youtube.com/vi/${id}/mqdefault.jpg`);
    if (!res.ok) return null;
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  } catch { return null; }
}

function deleteFile(p) {
  if (p) try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const I = { online: "🌐", local: "💾", ok: "✓", fail: "✗", none: "—" };

function icons(v) {
  const permanent = !!(v.videoPath);
  return {
    src:   permanent ? I.local : I.online,
    trans: hasCachedTranslation(v.id, permanent) ? I.ok : v.translationFailed ? I.fail : I.none,
  };
}

// ── mpv helpers ───────────────────────────────────────────────────────────────

function buildMpvArgs(target, quality) {
  const args = [];
  if (target.startsWith("http")) args.push(`--ytdl-format=${ytdlFormat(quality)}`);
  args.push(target);
  return args;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdAdd(url) {
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

  process.stdout.write("Завантажуємо thumbnail... ");
  const thumb = await downloadThumb(id);
  console.log(thumb ? "✓" : "—");
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

function cmdListPick() {
  const lib = loadLib();
  for (const v of lib.videos) {
    const { src, trans } = icons(v);
    process.stdout.write(`${src} ${trans}\t${v.id}\t${v.title}\n`);
  }
}

function cmdPick() {
  const lib = loadLib();
  if (!lib.videos.length) { die("Бібліотека порожня."); }

  const lines = lib.videos.map(v => {
    const { src, trans } = icons(v);
    return `${src} ${trans}\t${v.id}\t${v.title}`;
  }).join("\n");

  const preview =
    'id={2}; thumb="' + THUMB_DIR + '/$id.jpg"; ' +
    '[ -f "$thumb" ] || curl -s "https://img.youtube.com/vi/$id/mqdefault.jpg" -o "$thumb" 2>/dev/null; ' +
    '[ -f "$thumb" ] && kitten icat --clear --stdin=no --transfer-mode=file ' +
    '--place "${FZF_PREVIEW_COLUMNS}x${FZF_PREVIEW_LINES}@0x0" "$thumb" 2>/dev/null';

  const result = spawnSync("fzf", [
    "--delimiter=\t",
    "--with-nth=1,3",
    "--prompt=vot> ",
    "--height=80%",
    "--border=rounded",
    "--preview=" + preview,
    "--preview-window=right:35%",
    "--header=Enter=відкрити  Ctrl+D=видалити все  Ctrl+X=відео(скач/видал)  Ctrl+R=переклад(скач/видал)",
    "--bind=ctrl-d:execute-silent(vot _remove-silent {2})+reload(vot _list-pick)",
    "--bind=ctrl-x:execute(vot _toggle-video {2})+reload(vot _list-pick)",
    "--bind=ctrl-r:execute(vot _toggle-translation {2})+reload(vot _list-pick)",
  ], { input: lines, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });

  if (result.status !== 0 || !result.stdout.trim()) process.exit(0);

  const fields = result.stdout.trim().split("\t");
  const id = fields[1];
  const lib2 = loadLib();
  const video = lib2.videos.find(v => v.id === id);
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
  const [video] = lib.videos.splice(idx, 1);
  saveLib(lib);

  const removed = ["бібліотека"];
  if (video.videoPath)                                    { deleteFile(video.videoPath);                removed.push("відео"); }
  if (fs.existsSync(path.join(CACHE_DIR, id + ".mp3"))) { deleteFile(path.join(CACHE_DIR, id + ".mp3")); removed.push("переклад"); }
  if (fs.existsSync(thumbPath(id)))                      { deleteFile(thumbPath(id));                   removed.push("thumbnail"); }

  console.log(`✓ Видалено (${removed.join(", ")}): ${video.title}`);
}

function cmdRemoveSilent(id) {
  const lib = loadLib();
  const idx = lib.videos.findIndex(v => v.id === id);
  if (idx === -1) return;
  const [video] = lib.videos.splice(idx, 1);
  saveLib(lib);
  deleteFile(video.videoPath);
  deleteFile(path.join(CACHE_DIR, id + ".mp3"));
  deleteFile(thumbPath(id));
}

function cmdRemoveVideo(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) { die("Не знайдено: " + id); }
  if (!video.videoPath) { console.log("Відео не скачано"); return; }
  deleteFile(video.videoPath);
  video.videoPath = null;
  saveLib(lib);
  console.log("✓ Відео видалено, залишається в бібліотеці: " + video.title);
}

function cmdRemoveVideoSilent(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video || !video.videoPath) return;
  deleteFile(video.videoPath);
  video.videoPath = null;
  saveLib(lib);
}

function cmdRemoveTranslation(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) { die("Не знайдено: " + id); }
  const f = path.join(CACHE_DIR, id + ".mp3");
  if (!fs.existsSync(f)) { console.log("Переклад не знайдено"); return; }
  deleteFile(f);
  video.translationFailed = false;
  saveLib(lib);
  console.log("✓ Переклад видалено: " + video.title);
}

function cmdRemoveTranslationSilent(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) return;
  deleteFile(path.join(CACHE_DIR, id + ".mp3"));
  video.translationFailed = false;
  saveLib(lib);
}

function cmdClean() {
  const lib = loadLib();
  const ids = new Set(lib.videos.map(v => v.id));
  let count = 0;

  for (const [dir, ext] of [[CACHE_DIR, ".mp3"], [THUMB_DIR, ".jpg"]]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(ext)) continue;
        const id = f.slice(0, -ext.length);
        if (!ids.has(id)) { fs.unlinkSync(path.join(dir, f)); count++; }
      }
    } catch {}
  }

  console.log(count ? `✓ Видалено ${count} файлів` : "Нічого для очищення");
}

function cmdStatus() {
  const lib = loadLib();
  const total = lib.videos.length;
  const withTrans = lib.videos.filter(v => hasCachedTranslation(v.id, !!(v.videoPath))).length;
  const withVideo = lib.videos.filter(v => v.videoPath && fs.existsSync(v.videoPath)).length;
  const failed = lib.videos.filter(v => v.translationFailed).length;

  const sumDir = (dir, ext) => {
    try {
      return fs.readdirSync(dir)
        .filter(f => !ext || f.endsWith(ext))
        .reduce((s, f) => { try { return s + fs.statSync(path.join(dir, f)).size; } catch { return s; } }, 0);
    } catch { return 0; }
  };
  const fmt = b => {
    if (b < 1024) return b + " Б";
    if (b < 1024 ** 2) return (b / 1024).toFixed(1) + " КБ";
    if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + " МБ";
    return (b / 1024 ** 3).toFixed(2) + " ГБ";
  };

  const cacheSize = sumDir(CACHE_DIR, ".mp3");
  const thumbSize = sumDir(THUMB_DIR, ".jpg");
  const videoSize = sumDir(VIDEOS_DIR, null);

  console.log(`
  Відео в бібліотеці:  ${total}
  З перекладом:        ${withTrans}/${total}${failed ? "  (провалів: " + failed + ")" : ""}
  Скачано локально:    ${withVideo}/${total}

  Місце на диску:
    Переклади (MP3):   ${fmt(cacheSize)}
    Відео:             ${fmt(videoSize)}
    Thumbnails:        ${fmt(thumbSize)}
    Разом:             ${fmt(cacheSize + videoSize + thumbSize)}
`);
}

function fetchOne(video) {
  const lang = readConf().language || "ru";
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VOT_SCRIPT, "--prefetch", video.url, lang], {
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
  const toFetch = lib.videos.filter(v => !hasCachedTranslation(v.id, !!(v.videoPath)));

  if (!toFetch.length) {
    console.log("Всі відео вже мають переклад.");
    return;
  }

  const total = toFetch.length;
  const pad = String(total).length;
  console.log(`\nПерекладаємо ${total} відео (макс 5хв на кожне)...\n`);

  let successCount = 0;
  for (let i = 0; i < total; i++) {
    const v = toFetch[i];
    const label = `[${String(i + 1).padStart(pad)}/${total}]`;
    const title = v.title.slice(0, 55).padEnd(56);
    process.stdout.write(`${label} ${title}`);

    const ok = await fetchOne(v);
    console.log(ok ? "  ✓" : "  ✗");
    if (ok) successCount++;

    const entry = lib.videos.find(e => e.id === v.id);
    if (entry) entry.translationFailed = !ok;
    saveLib(lib);
  }

  const failed = total - successCount;
  console.log(`\n${"█".repeat(24)}  Готово: ${successCount}/${total}${failed ? "  (провалів: " + failed + ")" : ""}`);
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

async function cmdToggleVideo(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) return;

  if (video.videoPath && fs.existsSync(video.videoPath)) {
    deleteFile(video.videoPath);
    video.videoPath = null;
    saveLib(lib);
    console.log("✓ Відео видалено, залишається в бібліотеці");
  } else {
    const q = readConf().quality || "1080";
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    const template = path.join(VIDEOS_DIR, "%(title)s [%(id)s].%(ext)s");
    console.log(`Завантажуємо: ${video.title} (${q}p)`);
    const result = spawnSync("yt-dlp", ["-f", ytdlFormat(q), "-o", template, video.url], { stdio: "inherit" });
    if (result.status === 0) {
      const files = fs.readdirSync(VIDEOS_DIR).filter(f => f.includes("[" + video.id + "]"));
      if (files.length) {
        video.videoPath = path.join(VIDEOS_DIR, files[0]);
        saveLib(lib);
        console.log("✓ Збережено: " + video.videoPath);
      }
    }
  }
}

async function cmdToggleTranslation(id) {
  const lib = loadLib();
  const video = lib.videos.find(v => v.id === id);
  if (!video) return;

  const f = path.join(CACHE_DIR, id + ".mp3");
  if (fs.existsSync(f)) {
    deleteFile(f);
    video.translationFailed = false;
    saveLib(lib);
    console.log("✓ Переклад видалено");
  } else {
    console.log(`Перекладаємо: ${video.title}`);
    const ok = await fetchOne(video);
    video.translationFailed = !ok;
    saveLib(lib);
    console.log(ok ? "✓ Готово" : "✗ Провал");
  }
}

async function cmdSyncThumbs() {
  const lib = loadLib();
  const missing = lib.videos.filter(v => !fs.existsSync(thumbPath(v.id)));
  if (!missing.length) { console.log("Всі thumbnails є."); return; }
  console.log(`Завантажуємо thumbnails для ${missing.length} відео...\n`);
  for (const v of missing) {
    process.stdout.write(`  ${v.title.slice(0, 55).padEnd(56)}… `);
    const ok = await downloadThumb(v.id);
    console.log(ok ? "✓" : "—");
  }
}

async function cmdAddPlaylist(url) {
  if (!url) { die("Вкажіть URL плейлісту"); }
  console.log("Отримуємо список відео з плейлісту...");

  let entries;
  try {
    const out = execFileSync("yt-dlp", [
      "--flat-playlist", "--print", "%(id)s\t%(title)s", "--no-warnings", url,
    ], { timeout: 60000, encoding: "utf8" });
    entries = out.trim().split("\n").filter(Boolean).map(line => {
      const i = line.indexOf("\t");
      return { id: line.slice(0, i), title: line.slice(i + 1) };
    });
  } catch (e) { die("Помилка отримання плейлісту: " + e.message); }

  console.log(`Знайдено ${entries.length} відео.\n`);
  const lib = loadLib();
  let added = 0, skipped = 0;

  for (const { id, title } of entries) {
    if (lib.videos.find(v => v.id === id)) { skipped++; continue; }
    lib.videos.push({
      id, title, added: new Date().toISOString(),
      url: `https://www.youtube.com/watch?v=${id}`,
      translationFailed: false, videoPath: null,
    });
    console.log(`  ✓ ${title}`);
    added++;
  }
  saveLib(lib);
  console.log(`\nДодано: ${added}${skipped ? ", вже було: " + skipped : ""}`);

  if (added > 0) {
    console.log("\nЗавантажуємо thumbnails...");
    for (const { id } of entries.filter(e => !fs.existsSync(thumbPath(e.id)))) {
      await downloadThumb(id);
    }
    console.log("✓");
  }
}

function cmdUpdate() {
  console.log("Оновлення vot-mpv...");
  const pull = spawnSync("git", ["-C", SHARE_DIR, "pull"], { stdio: "inherit" });
  if (pull.status !== 0) { console.error("✗ git pull не вдався"); process.exit(1); }
  console.log("\nПеревстановлення...");
  spawnSync("bash", [path.join(SHARE_DIR, "install.sh")], { stdio: "inherit" });
}

// ── Entry point ───────────────────────────────────────────────────────────────

function die(msg) { console.error(msg); process.exit(1); }

function help() {
  console.log(`
vot — менеджер відео з перекладом

  add <url> [url2...]      Додати YouTube відео (можна кілька одразу)
  add --file <шлях>        Додати всі URL з текстового файлу (по одному на рядок)
  add-playlist <url>       Додати всі відео з плейлісту
  list                     Показати всі відео зі статусами
  pick                     fzf: Enter=відкрити  Ctrl+D=видалити все
                               Ctrl+X=відео(скач/видал)  Ctrl+R=переклад(скач/видал)
  play <id> [quality]      Відкрити в mpv (quality: 480/720/1080/2160/best)
  fetch <id>               Завантажити переклад для одного відео
  fetch --all              Завантажити переклади для всіх без перекладу
  download <id> [q]        Скачати відео (меню якості або вкажи q)
  remove <id>              Видалити з бібліотеки + відео + переклад + thumbnail
  remove-video <id>        Видалити тільки відео файл (залишити в бібліотеці)
  remove-translation <id>  Видалити тільки переклад
  clean                    Видалити переклади і thumbnails не з бібліотеки
  sync-thumbs              Завантажити thumbnails для всіх відео без них
  status                   Статистика бібліотеки і місце на диску
  update                   Оновити vot-mpv через git pull + переінсталяція

Іконки: 🌐 онлайн  💾 локальне  ✓ переклад є  ✗ провал  — немає
Якщо відео скачано — переклад зберігається назавжди (без 7-денного ліміту).
`);
}

const [,, cmd, arg, qualityArg] = process.argv;

(async () => {
  switch (cmd) {
    case "add": {
      const rest = process.argv.slice(3);
      if (!rest.length) die("Вкажіть URL або --file <шлях>");
      if (rest[0] === "--file") {
        const fp = rest[1];
        if (!fp) die("Вкажіть шлях до файлу після --file");
        const urls = fs.readFileSync(fp, "utf8")
          .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
        console.log(`Додаємо ${urls.length} відео з файлу...\n`);
        for (const u of urls) await cmdAdd(u);
      } else {
        for (const u of rest) await cmdAdd(u);
      }
      break;
    }
    case "add-playlist":           if (!arg) die("Вкажіть URL плейлісту"); await cmdAddPlaylist(arg); break;
    case "list":                   cmdList(); break;
    case "pick":                   cmdPick(); break;
    case "_list-pick":             cmdListPick(); break;
    case "play":                   if (!arg) die("Вкажіть ID"); cmdPlay(arg, qualityArg); break;
    case "remove":                 if (!arg) die("Вкажіть ID"); cmdRemove(arg); break;
    case "_remove-silent":         if (arg) cmdRemoveSilent(arg); break;
    case "remove-video":           if (!arg) die("Вкажіть ID"); cmdRemoveVideo(arg); break;
    case "_remove-video-silent":   if (arg) cmdRemoveVideoSilent(arg); break;
    case "remove-translation":     if (!arg) die("Вкажіть ID"); cmdRemoveTranslation(arg); break;
    case "_remove-translation-silent": if (arg) cmdRemoveTranslationSilent(arg); break;
    case "_toggle-video":              if (arg) await cmdToggleVideo(arg); break;
    case "_toggle-translation":        if (arg) await cmdToggleTranslation(arg); break;
    case "clean":                  cmdClean(); break;
    case "fetch":
      if (!arg) die("Вкажіть ID або --all");
      if (arg === "--all") await cmdFetchAll();
      else await cmdFetch(arg);
      break;
    case "download":               if (!arg) die("Вкажіть ID"); cmdDownload(arg, qualityArg); break;
    case "sync-thumbs":            await cmdSyncThumbs(); break;
    case "status":                 cmdStatus(); break;
    case "update":                 cmdUpdate(); break;
    default:                       help(); break;
  }
})();
