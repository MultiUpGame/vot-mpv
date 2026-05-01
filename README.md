# vot-mpv — голосовий переклад YouTube в mpv

Переклад англомовних YouTube відео на російську мову прямо в mpv.
Використовує Яндекс Translation API через Cloudflare воркер `vot-worker.eu.cc`.

---

## Встановлення

**Залежності:**
```bash
sudo pacman -S nodejs yt-dlp mpv fzf
```

**Встановлення:**
```bash
git clone https://github.com/MultiUpGame/vot-mpv ~/.local/share/vot-mpv
cd ~/.local/share/vot-mpv
bash install.sh
```

---

## Файли системи

```
~/.local/share/vot-mpv/
├── vot-translate.js        # Node.js скрипт перекладу (серце системи)
├── vot-cli.js              # CLI менеджер бібліотеки
├── vot.lua                 # Lua скрипт для mpv
├── integrations/
│   ├── ytv                 # YouTube пошук + інтеграція з бібліотекою
│   └── ytv-fmt             # Допоміжний форматер для ytv
├── node_modules/           # npm пакети (@vot.js/node)
└── library.json            # Бібліотека відео (створюється автоматично)

~/.config/mpv/scripts/
└── vot.lua                 # (копія, завантажується mpv)

~/.config/mpv/script-opts/
└── vot.conf                # налаштування

~/.cache/vot/
└── <videoId>.mp3           # кеш перекладів (7 днів)

~/Videos/vot/
└── Назва відео [videoId].webm  # скачані відео
```

---

## Використання

### Переклад в mpv (як і раніше)

```bash
mpv 'https://www.youtube.com/watch?v=...'
```
Натисни **Ctrl+T** — вмикає/вимикає переклад.
Якщо переклад вже є в кеші — починається миттєво.

Працює і для **локальних файлів** скачаних через `vot download` —
скрипт витягує videoId з назви файлу і бере переклад з кешу.

---

### vot — менеджер бібліотеки

```bash
vot add <url>              # Додати відео до бібліотеки (автоматично бере назву)
vot list                   # Показати всі відео зі статусами
vot pick                   # Вибрати через fzf → відкрити в mpv
vot play <id> [quality]    # Відкрити відео в mpv (quality: 480/720/1080/2160/best)
vot remove <id>            # Видалити з бібліотеки
vot fetch <id>             # Завантажити переклад для одного відео
vot fetch --all            # Завантажити переклади для всіх (по черзі, макс 5хв/відео)
vot download <id> [q]      # Скачати відео (меню вибору якості або вкажи q)
```

**Іконки в `vot list`:**
```
  Src  Пер  ID            Назва
  ────────────────────────────────────────────────
  🌐   ✓   dQw4w9WgXcQ  Rick Astley - Never Gonna Give You Up
  💾   ✓   HH50ccnDbaU  Become a Hyprland God With Hyprctl
  🌐   ✗   abc12345678  Відео яке не вдалось перекласти
  🌐   —   xyz98765432  Відео без перекладу

  🌐 онлайн  💾 локальний файл
  ✓ переклад є  ✗ провал  — немає
```

---

### ytv — пошук YouTube з інтеграцією бібліотеки

```bash
ytv hyprland tutorial
```

Відкриває fzf зі списком результатів:
```
★  18:27  saneAspect            Hyprland - Best Tiling WM in 2025
   45:12  typecraft              Hyprland Complete Config Guide
★  32:05  Dreams of Code         Hyprland Dotfiles from Scratch
```
`★` — вже є в бібліотеці.

| Клавіша | Дія |
|---------|-----|
| `Enter` | Відкрити відео в mpv |
| `Ctrl+A` | Додати в бібліотеку (залишається в fzf, ★ з'являється) |
| `Esc` | Вийти |

---

## Налаштування (vot.conf)

`~/.config/mpv/script-opts/vot.conf`:

```ini
language=ru          # мова озвучки перекладу (ru / en / kk)
autoTranslate=no     # автоматично перекладати при відкритті відео (yes/no)
quality=1080         # якість для перегляду і скачування (480/720/1080/2160/best)
vot_bin=/usr/bin/node
vot_script=/home/multi-man/.local/share/vot-mpv/vot-translate.js
```

**Підтримувані мови:**

| Параметр | Значення |
|----------|---------|
| `language` (озвучка) | `ru`, `en`, `kk` — більше Яндекс не підтримує |
| Вхідна мова відео | визначається автоматично: en, zh, ko, de, fr, es, it, ja, ar та інші |

Українська озвучка недоступна — Яндекс її не має в TTS.

`quality` використовується як дефолт для `vot play`, `vot pick`, `vot download` і `ytv`.
`vot download` завжди показує меню вибору, але підсвічує дефолт з конфігу.

**Якщо відео гальмує або десинхронізується** — додай у `~/.config/mpv/mpv.conf`:
```ini
hwdec=auto
```
Вмикає апаратне декодування (VA-API/VDPAU). Особливо важливо для 4K/AV1.

---

## Як це працює

### Переклад

1. **Ctrl+T** → `vot.lua` запускає `vot-translate.js <url> /tmp/vot_xxx.mp3`
2. Скрипт перевіряє `~/.cache/vot/<videoId>.mp3` — якщо є і свіжіше 7 днів, повертає одразу
3. Інакше — запит до `vot-worker.eu.cc` (Cloudflare проксі до Яндекса)
4. Яндекс повертає URL аудіо на S3 → замінюється на audio-proxy воркера
5. URL передається в mpv одразу (стрімінг), паралельно фоновий процес зберігає MP3 в кеш

### Чому через воркер, а не напряму

Яндекс заблокований в Україні на рівні DNS і IP.
`vot-worker.eu.cc` — Cloudflare Workers проксі, його IP не заблокований.

### Локальні файли

`vot.lua` витягує videoId з назви файлу формату `Назва [videoId].webm`
і конструює YouTube URL для пошуку перекладу в кеші.

### Чому деякі відео не перекладаються

YouTube заблокований в Росії з серпня 2024. Яндекс не може завантажити нові відео.
Працюють тільки відео що вже є в кеші Яндекса (перекладались раніше через браузерне розширення).

### IPv6 проблема в Node.js

Node.js за замовчуванням пробує IPv6 першим — таймаут ~3с перед IPv4.
Вирішення: `require("dns").setDefaultResultOrder("ipv4first")` + власна `fetchFn` з таймаутом 15с.

---

## Залежності

| Пакет | Для чого |
|-------|---------|
| `nodejs` | запуск vot-translate.js |
| `yt-dlp` | тривалість відео + пошук (ytv) + скачування |
| `mpv` | відтворення |
| `fzf` | інтерактивний вибір в `vot pick` і `ytv` |
| `@vot.js/node` | VOT API клієнт (npm, в node_modules/) |
