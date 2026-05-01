#!/bin/bash
set -e

INSTALL_DIR="$HOME/.local/share/vot-mpv"
MPV_SCRIPTS="$HOME/.config/mpv/scripts"
MPV_OPTS="$HOME/.config/mpv/script-opts"
INPUT_CONF="$HOME/.config/mpv/input.conf"

echo "=== vot-mpv installer ==="

# Перевірка залежностей
if ! command -v node &>/dev/null; then
    echo "Помилка: Node.js не знайдено. Встанови: sudo pacman -S nodejs"
    exit 1
fi
if ! command -v yt-dlp &>/dev/null; then
    echo "Попередження: yt-dlp не знайдено (рекомендовано). Встанови: sudo pacman -S yt-dlp"
fi

# Встановлення скрипту
mkdir -p "$INSTALL_DIR"
cp vot-translate.js "$INSTALL_DIR/"
cp package.json "$INSTALL_DIR/"

echo "Встановлення npm залежностей..."
cd "$INSTALL_DIR"
npm install --silent

# Встановлення mpv скриптів
mkdir -p "$MPV_SCRIPTS" "$MPV_OPTS"
cp "$OLDPWD/vot.lua" "$MPV_SCRIPTS/vot.lua"

# vot.conf — не перезаписуємо якщо вже існує
if [ ! -f "$MPV_OPTS/vot.conf" ]; then
    cp "$OLDPWD/vot.conf.example" "$MPV_OPTS/vot.conf"
    echo "Створено $MPV_OPTS/vot.conf"
else
    echo "Пропускаємо $MPV_OPTS/vot.conf (вже існує)"
fi

# input.conf — додаємо прив'язки якщо ще нема
if [ ! -f "$INPUT_CONF" ]; then
    cp "$OLDPWD/input.conf.example" "$INPUT_CONF"
    echo "Створено $INPUT_CONF"
else
    if ! grep -q "vot/toggle" "$INPUT_CONF"; then
        echo "" >> "$INPUT_CONF"
        cat "$OLDPWD/input.conf.example" >> "$INPUT_CONF"
        echo "Додано прив'язки клавіш в $INPUT_CONF"
    else
        echo "Пропускаємо $INPUT_CONF (прив'язки вже є)"
    fi
fi

echo ""
echo "=== Готово! ==="
echo "Відкрий YouTube відео в mpv і натисни Ctrl+T для перекладу."
