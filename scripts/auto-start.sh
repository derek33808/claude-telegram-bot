#!/bin/bash
# Auto-start Claude Telegram Bot when a tmux session is created.
# Triggered by tmux session-created hook.
# Usage: auto-start.sh <session_name>

SESSION_NAME="$1"
BOT_PID_FILE="/tmp/claude-telegram-bot.pid"
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/claude-telegram-bot-ts.log"

# Check if bot is already running
if [ -f "$BOT_PID_FILE" ] && kill -0 "$(cat "$BOT_PID_FILE")" 2>/dev/null; then
    exit 0  # Already running
fi

# Wait for session to initialize
sleep 2

# Detect if the session is running claude
PANE_CMD=$(tmux display-message -t "$SESSION_NAME" -p '#{pane_current_command}' 2>/dev/null)
PANE_TITLE=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null | head -5)

if echo "$PANE_CMD $PANE_TITLE" | grep -qi "claude"; then
    cd "$BOT_DIR" || exit 1
    BOT_AUTO_LIFECYCLE=true nohup bun run start >> "$LOG_FILE" 2>&1 &
    echo $! > "$BOT_PID_FILE"
    echo "[$(date)] Auto-started bot (PID: $!) triggered by session: $SESSION_NAME" >> "$LOG_FILE"
fi
