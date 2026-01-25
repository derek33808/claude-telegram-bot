#!/usr/bin/env python3
"""
Claude Code Hook Script - Telegram Integration

This hook captures Claude Code events and sends confirmation requests to Telegram.
For PreToolUse events that require confirmation, it:
1. Sends a notification to Telegram with tool details
2. Waits for user response (Allow/Deny)
3. Returns appropriate exit code

Exit codes:
- 0: Allow the operation
- 2: Deny/block the operation
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# Configuration
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
PENDING_DIR = Path("/tmp/claude-telegram-hooks")
POLL_INTERVAL = 1  # seconds
POLL_TIMEOUT = 300  # 5 minutes max wait

# Tools that require confirmation
CONFIRM_TOOLS = {
    "Bash": ["rm", "sudo", "chmod", "chown", "mv", "git push", "git reset", "npm publish"],
    "Write": True,  # All write operations
    "Edit": True,   # All edit operations
    "NotebookEdit": True,
}

# Tools to skip (don't need confirmation)
SKIP_TOOLS = {"Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite"}


def ensure_dir():
    """Ensure the pending directory exists."""
    PENDING_DIR.mkdir(parents=True, exist_ok=True)


def send_telegram_message(text: str, reply_markup: dict = None) -> dict:
    """Send a message to Telegram and return the response."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return None

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
    }
    if reply_markup:
        data["reply_markup"] = json.dumps(reply_markup)

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Failed to send Telegram message: {e}", file=sys.stderr)
        return None


def needs_confirmation(tool_name: str, tool_input: dict) -> bool:
    """Check if a tool use requires confirmation."""
    if tool_name in SKIP_TOOLS:
        return False

    if tool_name not in CONFIRM_TOOLS:
        return False

    confirm_rule = CONFIRM_TOOLS[tool_name]

    # If True, always confirm
    if confirm_rule is True:
        return True

    # For Bash, check if command contains dangerous patterns
    if tool_name == "Bash" and isinstance(confirm_rule, list):
        command = tool_input.get("command", "")
        for pattern in confirm_rule:
            if pattern in command:
                return True
        return False

    return False


def format_tool_message(tool_name: str, tool_input: dict, session_id: str) -> str:
    """Format a tool use message for Telegram."""
    lines = [f"🔔 <b>Claude Code 请求确认</b>\n"]
    lines.append(f"<b>工具:</b> {tool_name}")

    if tool_name == "Bash":
        command = tool_input.get("command", "")[:500]
        lines.append(f"<b>命令:</b>\n<code>{command}</code>")
    elif tool_name in ("Write", "Edit"):
        file_path = tool_input.get("file_path", "unknown")
        lines.append(f"<b>文件:</b> <code>{file_path}</code>")
    elif tool_name == "NotebookEdit":
        notebook = tool_input.get("notebook_path", "unknown")
        lines.append(f"<b>Notebook:</b> <code>{notebook}</code>")
    else:
        # Generic display
        for key, value in list(tool_input.items())[:3]:
            val_str = str(value)[:100]
            lines.append(f"<b>{key}:</b> {val_str}")

    lines.append(f"\n<i>Session: {session_id[:8]}...</i>")
    return "\n".join(lines)


def create_pending_request(request_id: str, tool_name: str, tool_input: dict):
    """Create a pending request file."""
    ensure_dir()
    request_file = PENDING_DIR / f"{request_id}.json"
    data = {
        "id": request_id,
        "tool": tool_name,
        "input": tool_input,
        "status": "pending",
        "created_at": time.time(),
    }
    with open(request_file, "w") as f:
        json.dump(data, f)


def wait_for_response(request_id: str) -> str:
    """Poll for response from Telegram. Returns 'allow' or 'deny'."""
    request_file = PENDING_DIR / f"{request_id}.json"
    start_time = time.time()

    while time.time() - start_time < POLL_TIMEOUT:
        try:
            with open(request_file) as f:
                data = json.load(f)

            if data.get("status") in ("allow", "deny"):
                # Clean up
                request_file.unlink(missing_ok=True)
                return data["status"]
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        time.sleep(POLL_INTERVAL)

    # Timeout - default to allow (fail-open)
    request_file.unlink(missing_ok=True)
    return "allow"


def cleanup_old_requests():
    """Clean up old pending requests (older than 10 minutes)."""
    ensure_dir()
    cutoff = time.time() - 600  # 10 minutes
    for f in PENDING_DIR.glob("*.json"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except Exception:
            pass


def main():
    # Read event from stdin
    try:
        event_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)  # Invalid input, allow by default

    # Only handle PreToolUse events
    event_type = event_data.get("event")
    if event_type != "PreToolUse":
        sys.exit(0)

    tool_name = event_data.get("tool_name", "")
    tool_input = event_data.get("tool_input", {})
    session_id = event_data.get("session_id", "unknown")

    # Check if this tool needs confirmation
    if not needs_confirmation(tool_name, tool_input):
        sys.exit(0)

    # Clean up old requests
    cleanup_old_requests()

    # Generate request ID
    request_id = f"{session_id[:8]}-{int(time.time() * 1000)}"

    # Create pending request
    create_pending_request(request_id, tool_name, tool_input)

    # Format and send Telegram message
    message = format_tool_message(tool_name, tool_input, session_id)
    reply_markup = {
        "inline_keyboard": [[
            {"text": "✅ 允许", "callback_data": f"hook:allow:{request_id}"},
            {"text": "❌ 拒绝", "callback_data": f"hook:deny:{request_id}"},
        ]]
    }

    result = send_telegram_message(message, reply_markup)
    if not result or not result.get("ok"):
        # Failed to send, allow by default
        sys.exit(0)

    # Wait for response
    response = wait_for_response(request_id)

    if response == "deny":
        # Block the operation
        print(json.dumps({
            "decision": "block",
            "reason": "User denied via Telegram"
        }))
        sys.exit(2)
    else:
        # Allow the operation
        sys.exit(0)


if __name__ == "__main__":
    main()
