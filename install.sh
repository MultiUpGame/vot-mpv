#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/vot-mpv"
BIN_DIR="$HOME/.local/bin"
MPV_SCRIPTS="$HOME/.config/mpv/scripts"
MPV_OPTS="$HOME/.config/mpv/script-opts"
MPV_CONF="$HOME/.config/mpv/mpv.conf"
INPUT_CONF="$HOME/.config/mpv/input.conf"

echo "=== vot-mpv installer ==="
echo ""

# ── Перевірка залежностей ─────────────────────────────────────────────────────

check() {
    if command -v "$1" &>/dev/null; then
        echo "  ✓ $1"
    else
        echo "  ✗ $1 — не знайдено. $2"
        [ "$3" = "required" ] && exit 1
    fi
}

echo "Перевірка залежностей:"
check node   "Встанови: sudo pacman -S nodejs"   required
check mpv    "Встанови: sudo pacman -S mpv"       required
check yt-dlp "Встанови: sudo pacman -S yt-dlp"   required
check fzf    "Встанови: sudo pacman -S fzf"       required
echo ""

# ── Копіювання файлів ─────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR/integrations"

for f in vot-translate.js vot-cli.js vot.lua package.json; do
    [ "$SCRIPT_DIR/$f" != "$INSTALL_DIR/$f" ] && cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
done
[ "$SCRIPT_DIR/integrations/ytv" != "$INSTALL_DIR/integrations/ytv" ] && \
    cp "$SCRIPT_DIR/integrations/ytv"     "$INSTALL_DIR/integrations/ytv"
[ "$SCRIPT_DIR/integrations/ytv-fmt" != "$INSTALL_DIR/integrations/ytv-fmt" ] && \
    cp "$SCRIPT_DIR/integrations/ytv-fmt" "$INSTALL_DIR/integrations/ytv-fmt"
chmod +x "$INSTALL_DIR/integrations/ytv" "$INSTALL_DIR/integrations/ytv-fmt"

echo "Встановлення npm залежностей..."
cd "$INSTALL_DIR" && npm install --silent
echo "  ✓ npm пакети встановлено"
echo ""

# ── mpv скрипти ───────────────────────────────────────────────────────────────

mkdir -p "$MPV_SCRIPTS" "$MPV_OPTS"
cp "$INSTALL_DIR/vot.lua" "$MPV_SCRIPTS/vot.lua"
echo "✓ $MPV_SCRIPTS/vot.lua"

if [ ! -f "$MPV_OPTS/vot.conf" ]; then
    cp "$SCRIPT_DIR/vot.conf.example" "$MPV_OPTS/vot.conf"
    echo "✓ $MPV_OPTS/vot.conf (створено з прикладу)"
else
    echo "~ $MPV_OPTS/vot.conf (вже існує, пропускаємо)"
fi

if [ ! -f "$INPUT_CONF" ]; then
    cp "$SCRIPT_DIR/input.conf.example" "$INPUT_CONF"
    echo "✓ $INPUT_CONF"
else
    if ! grep -q "vot/toggle" "$INPUT_CONF"; then
        echo "" >> "$INPUT_CONF"
        cat "$SCRIPT_DIR/input.conf.example" >> "$INPUT_CONF"
        echo "✓ $INPUT_CONF (додано прив'язки клавіш)"
    else
        echo "~ $INPUT_CONF (прив'язки вже є)"
    fi
fi

# ── mpv.conf — рекомендовані параметри ───────────────────────────────────────

if [ ! -f "$MPV_CONF" ]; then
    cat > "$MPV_CONF" <<'EOF'
hwdec=vaapi
hwdec-codecs=h264,hevc,vp8,vp9
save-watch-history=yes
EOF
    echo "✓ $MPV_CONF (створено)"
else
    echo "~ $MPV_CONF (вже існує, перевір вручну)"
    echo "    Рекомендовано додати:"
    echo "      hwdec=vaapi"
    echo "      hwdec-codecs=h264,hevc,vp8,vp9"
    echo "      save-watch-history=yes"
fi

# ── CLI інструменти ───────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/vot" <<EOF
#!/bin/bash
exec node "$INSTALL_DIR/vot-cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/vot"
echo "✓ $BIN_DIR/vot"

cp "$INSTALL_DIR/integrations/ytv"     "$BIN_DIR/ytv"
cp "$INSTALL_DIR/integrations/ytv-fmt" "$BIN_DIR/ytv-fmt"
echo "✓ $BIN_DIR/ytv"
echo "✓ $BIN_DIR/ytv-fmt"

# ── Перевірка PATH ────────────────────────────────────────────────────────────

if ! echo "$PATH" | tr ':' '\n' | grep -q "$BIN_DIR"; then
    echo ""
    echo "⚠ $BIN_DIR не знайдено в PATH."
    echo "  Додай в ~/.bashrc або ~/.zshrc:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Готово ────────────────────────────────────────────────────────────────────

echo ""
echo "=== Готово! ==="
echo ""
echo "Основне:"
echo "  mpv <youtube-url>     відкрити відео (переклад автоматично якщо autoTranslate=yes)"
echo "  Ctrl+T                вмикає/вимикає переклад в mpv"
echo ""
echo "Бібліотека:"
echo "  vot add <url>         додати відео"
echo "  vot list              показати список"
echo "  vot pick              вибрати через fzf → mpv"
echo "  vot fetch --all       завантажити переклади для всіх"
echo "  vot download <id>     скачати відео"
echo ""
echo "Пошук:"
echo "  ytv <запит>           пошук YouTube → mpv з перекладом"
echo ""
echo "Налаштування: $MPV_OPTS/vot.conf"
