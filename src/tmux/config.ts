/**
 * Configuration for Tmux Bridge.
 *
 * All settings can be overridden via environment variables.
 */

import type { TmuxBridgeConfig } from "./types";

/**
 * Whether tmux bridge is enabled.
 * Set TMUX_BRIDGE_ENABLED=true to use tmux mode.
 */
export const TMUX_ENABLED =
  (process.env.TMUX_BRIDGE_ENABLED || "false").toLowerCase() === "true";

/**
 * Prefix for tmux session names.
 * Sessions will be named: {prefix}-{timestamp}
 */
export const TMUX_SESSION_PREFIX =
  process.env.TMUX_SESSION_PREFIX || "claude-tg";

/**
 * Polling interval for capturing tmux output (in milliseconds).
 * Lower values = more responsive but higher CPU usage.
 */
export const TMUX_POLL_INTERVAL = parseInt(
  process.env.TMUX_POLL_INTERVAL || "100",
  10
);

/**
 * Maximum time to wait for a response (in milliseconds).
 * Default: 5 minutes (300000ms)
 */
export const TMUX_MAX_POLL_TIME = parseInt(
  process.env.TMUX_MAX_POLL_TIME || "300000",
  10
);

/**
 * Idle timeout before auto-cleanup of Telegram-created sessions.
 * Default: 10 minutes (600000ms)
 */
export const TMUX_IDLE_TIMEOUT = parseInt(
  process.env.TMUX_IDLE_TIMEOUT || "600000",
  10
);

/**
 * Path to tmux executable.
 * Usually "tmux" if in PATH, or full path like "/opt/homebrew/bin/tmux"
 */
export const TMUX_PATH = process.env.TMUX_PATH || "tmux";

/**
 * Path to Claude Code executable.
 * Usually "claude" if in PATH.
 */
export const CLAUDE_PATH = process.env.CLAUDE_CODE_PATH || "claude";

/**
 * Lock timeout in milliseconds.
 * How long a lock is valid before expiring.
 * Default: 60 seconds (60000ms)
 */
export const TMUX_LOCK_TIMEOUT = parseInt(
  process.env.TMUX_LOCK_TIMEOUT || "60000",
  10
);

/**
 * Scrollback history limit for tmux pane.
 * Higher values allow reading more history but use more memory.
 */
export const TMUX_HISTORY_LIMIT = parseInt(
  process.env.TMUX_HISTORY_LIMIT || "10000",
  10
);

/**
 * Get default tmux bridge configuration.
 *
 * @param workingDir - Working directory for Claude Code
 * @returns TmuxBridgeConfig
 */
export function getDefaultConfig(workingDir: string): TmuxBridgeConfig {
  return {
    sessionPrefix: TMUX_SESSION_PREFIX,
    pollIntervalMs: TMUX_POLL_INTERVAL,
    maxPollTimeMs: TMUX_MAX_POLL_TIME,
    claudePath: CLAUDE_PATH,
    workingDir,
    tmuxPath: TMUX_PATH,
    historyLimit: TMUX_HISTORY_LIMIT,
    idleTimeoutMs: TMUX_IDLE_TIMEOUT,
  };
}

/**
 * Directory for storing tmux session metadata.
 */
export const TMUX_DATA_DIR =
  process.env.TMUX_DATA_DIR || "/tmp/claude-telegram-tmux";

/**
 * File for storing active locks.
 */
export const TMUX_LOCK_FILE = `${TMUX_DATA_DIR}/locks.json`;

/**
 * File for storing session metadata.
 */
export const TMUX_SESSION_FILE = `${TMUX_DATA_DIR}/sessions.json`;
