# vot-mpv — голосовий переклад YouTube в mpv

Система для перекладу англомовних YouTube відео на російську мову прямо в mpv плеєрі.
Використовує Яндекс Браузер Translation API через Cloudflare воркер як проміжний сервер.

---

## Встановлення

**Залежності:**
```bash
sudo pacman -S nodejs yt-dlp mpv   # Arch Linux
```

**Встановлення:**
```bash
git clone https://github.com/multi-man/vot-mpv ~/.local/share/vot-mpv
cd ~/.local/share/vot-mpv
bash install.sh
```

Готово. Відкрий YouTube в mpv і натисни **Ctrl+T**.

---

## Файли системи

```
~/.local/share/vot-mpv/
├── vot-translate.js        # Node.js скрипт — серце системи
├── node_modules/           # npm пакети (@vot.js/node)
└── README.md               # цей файл

~/.config/mpv/scripts/
└── vot.lua                 # Lua скрипт для mpv

~/.config/mpv/script-opts/
└── vot.conf                # налаштування

~/.config/mpv/
└── input.conf              # прив'язки клавіш

~/.cache/vot/
└── <videoId>.mp3           # локальний кеш перекладів (7 днів)
```

---

## Як користуватись

Відкрий YouTube відео в mpv:
```bash
mpv 'https://www.youtube.com/watch?v=...'
```

Натисни **Ctrl+T** — на екрані з'явиться статус перекладу. Коли готово — автоматично увімкнеться другий аудіотрек з перекладом.

Повторний **Ctrl+T** — вимикає переклад.

Якщо відео вже перекладалось раніше (є в кеші) — переклад починається **миттєво**.

---

## Як це працює зсередини

### 1. Клавіша → Lua → Node.js

Коли натискаєш Ctrl+T, `vot.lua` запускає `vot-translate.js` як підпроцес:
```
node vot-translate.js <YouTube-URL> /tmp/vot_1234.mp3
```

Аргумент `/tmp/vot_1234.mp3` — це базовий шлях для `.status` файлу прогресу (сам файл MP3 більше не створюється тут, тільки `.status`).

Кожні 2 секунди Lua читає `/tmp/vot_1234.mp3.status` і виводить вміст на OSD (текст на екрані mpv).

### 2. Перевірка локального кешу

Перш за все скрипт дивиться чи є вже збережений переклад:
```
~/.cache/vot/<videoId>.mp3
```
де `<videoId>` — ID відео з YouTube URL (наприклад `QTzpTAtds2c`).

Якщо файл існує і свіжіший 7 днів — одразу передає шлях до нього в mpv. Без жодних запитів до Яндекса.

### 3. Чому не можна звертатись до Яндекса напряму

Яндекс заблокований в Україні на двох рівнях:

**DNS-блокування** — провайдер повертає неправильну IP-адресу для `api.browser.yandex.ru`.
Вирішення: змінено DNS на `1.1.1.1` (Cloudflare):
```bash
nmcli connection modify "Batari" ipv4.dns "1.1.1.1 8.8.8.8" ipv4.ignore-auto-dns yes
```

**IP-блокування** — навіть з правильним DNS, IP-адреса Яндекса (`213.180.193.x`) заблокована на рівні firewall провайдера.
Вирішення: всі запити йдуть через `vot-worker.eu.cc` — це Cloudflare Workers сервер, який проксіює запити до Яндекса. Його IP не заблокований.

### 4. Отримання метаданих відео

```javascript
const data = await videoData.getVideoData(url);
```

Бібліотека `@vot.js/node` витягує з YouTube: ID відео, мову, тривалість.

**Проблема з тривалістю**: `getVideoData` іноді не повертає тривалість для YouTube. Яндекс використовує тривалість щоб розрахувати час обробки — без неї може некоректно обробляти запит.

Якщо тривалість відсутня — запускається `yt-dlp`:
```bash
yt-dlp --print duration <url>
```

### 5. Запит до Яндекса

```javascript
const client = new VOTWorkerClient({ host: "vot-worker.eu.cc", fetchFn });
result = await client.translateVideo({ videoData: data, responseLang: "ru" });
```

Яндекс може відповісти трьома способами:

| Відповідь | Значення | Що робимо |
|---|---|---|
| `translated: true` + `url` | Переклад готовий | Беремо URL аудіо |
| `translated: false` + `remainingTime: N` | Яндекс ще обробляє | Чекаємо N секунд, повторюємо |
| виняток `shouldRetry: 1` | Яндекс просить зачекати | Чекаємо 30с, повторюємо |

Максимум 60 спроб (~30 хвилин). Якщо відео взагалі недоступне Яндексу — буде `shouldRetry` на всі 60 спроб.

**Чому деякі відео не перекладаються**: YouTube заблокований в Росії з серпня 2024 року. Яндекс не може завантажити нові відео для перекладу. Працюють тільки ті відео, які вже є в кеші Яндекса (були перекладені раніше іншими користувачами через браузерне розширення).

### 6. Проблема IPv6 в Node.js

Node.js за замовчуванням спочатку пробує IPv6-підключення, яке таймаутить через ~3 секунди перед тим як спробувати IPv4. Це викликало помилку `This operation was aborted` при кожному запиті.

Вирішення — перший рядок скрипту:
```javascript
require("dns").setDefaultResultOrder("ipv4first");
```

Плюс власна `fetchFn` з таймаутом 15 секунд замість стандартного 3-секундного.

### 7. Отримання аудіо

Яндекс зберігає готове аудіо на S3:
```
https://vtrans.s3-private.mds.yandex.net/tts/prod/...
```

Цей домен теж заблокований в Україні. Тому URL замінюється на проксі:
```
https://vot-worker.eu.cc/video-translation/audio-proxy/...
```

### 8. Стрімінг замість завантаження

Раніше скрипт завантажував весь MP3 файл (~5-20 МБ для довгих відео) перш ніж mpv міг його відтворити. Тепер:

```javascript
// Виводимо URL одразу — mpv починає стрімити
process.stdout.write(proxiedUrl + "\n");

// Фоновий процес зберігає файл в кеш (відокремлений, не блокує)
const child = spawn(process.execPath, [__filename, "--download-cache", proxiedUrl, cacheFile], {
    detached: true,
    stdio: "ignore",
});
child.unref();

process.exit(0); // виходимо одразу, не чекаємо завантаження
```

mpv отримує URL → одразу починає грати через стрімінг. Паралельно фоновий процес (вже відокремлений від основного) тихо зберігає файл у `~/.cache/vot/`.

### 9. Lua читає stdout

```lua
local output = (result.stdout or ""):match("^([^\n]+)")
if output and output ~= "" then
    mp.commandv("audio-add", output, "select", "VOT ru")
end
```

`output` — це або URL (для стрімінгу), або шлях до кешованого файлу. mpv обробляє обидва варіанти однаково через `audio-add`.

---

## Налаштування (vot.conf)

```ini
language=ru          # мова перекладу
autoTranslate=no     # автоматично перекладати при відкритті відео
vot_bin=/usr/bin/node
vot_script=/home/multi-man/.local/share/vot-mpv/vot-translate.js
```

Щоб переклад вмикався автоматично для всіх онлайн-відео:
```ini
autoTranslate=yes
```

---

## Залежності

- `node` (`/usr/bin/node`) — Node.js 18+
- `yt-dlp` (`/usr/bin/yt-dlp`) — для визначення тривалості відео
- `@vot.js/node` — встановлено в `node_modules/`:
  ```bash
  cd ~/.local/share/vot-mpv
  npm install @vot.js/node
  ```

---

## Кеш

Переклади зберігаються в `~/.cache/vot/` під назвою `<videoId>.mp3`.
Термін дії — 7 днів. Після закінчення — автоматично перекладається знову.

Очистити кеш вручну:
```bash
rm -rf ~/.cache/vot/
```
