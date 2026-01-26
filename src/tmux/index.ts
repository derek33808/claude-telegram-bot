/**
 * Tmux Bridge Module
 *
 * Provides tmux-based interaction with Claude Code CLI.
 */

// Export types
export type {
  TmuxSession,
  TmuxBridgeConfig,
  TmuxLock,
  TmuxBridgeStatus,
  ParsedBlock,
  StatusCallback,
} from "./types";

export { ParseState } from "./types";

// Export config
export {
  TMUX_ENABLED,
  TMUX_SESSION_PREFIX,
  TMUX_POLL_INTERVAL,
  TMUX_MAX_POLL_TIME,
  TMUX_IDLE_TIMEOUT,
  TMUX_PATH,
  CLAUDE_PATH,
  TMUX_LOCK_TIMEOUT,
  TMUX_DATA_DIR,
  getDefaultConfig,
} from "./config";

// Export parser
export { TerminalOutputParser, PATTERNS, stripAnsi, cleanOutput } from "./parser";

// Export bridge
export { TmuxBridge } from "./bridge";
