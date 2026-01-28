#!/bin/bash
# Install tmux hooks for auto-starting Claude Telegram Bot.
# Run this once to set up automatic lifecycle management.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.config/claude-telegram-bot"

echo "Installing Claude Telegram Bot tmux hooks..."

# Copy auto-start script to config dir
mkdir -p "$CONFIG_DIR"
cp "$SCRIPT_DIR/auto-start.sh" "$CONFIG_DIR/"
chmod +x "$CONFIG_DIR/auto-start.sh"
echo "  Copied auto-start.sh to $CONFIG_DIR/"

# Add hook to tmux.conf
TMUX_CONF="$HOME/.tmux.conf"
if ! grep -q "claude-telegram-bot" "$TMUX_CONF" 2>/dev/null; then
    echo "" >> "$TMUX_CONF"
    echo "# Claude Telegram Bot auto-start" >> "$TMUX_CONF"
    echo "set-hook -g session-created 'run-shell \"$CONFIG_DIR/auto-start.sh #{session_name}\"'" >> "$TMUX_CONF"
    echo "  Hook added to $TMUX_CONF"
else
    echo "  Hook already exists in $TMUX_CONF (skipped)"
fi

echo ""
echo "Installation complete!"
echo "The bot will auto-start when you launch Claude in tmux."
echo "To uninstall, remove the 'Claude Telegram Bot' lines from $TMUX_CONF"
