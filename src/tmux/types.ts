/**
 * Type definitions for Tmux Bridge.
 */

import type { StatusCallback } from "../types";

/**
 * Represents a tmux session.
 */
export interface TmuxSession {
  /** Unique tmux session name (e.g., "claude-tg-1706280000") */
  sessionName: string;
  /** Window ID within the session */
  windowId: string;
  /** Pane ID within the window */
  paneId: string;
  /** Working directory of the session */
  workingDir: string;
  /** Whether the session is currently running */
  isRunning: boolean;
  /** Who created this session */
  createdBy: "telegram" | "cli";
  /** Whether Telegram currently owns/controls this session */
  isOwned: boolean;
  /** Whether the session is marked for automatic cleanup */
  markedForExit: boolean;
  /** When the session was marked for exit */
  markedAt?: Date;
  /** Last activity timestamp */
  lastActivity: Date;
}

/**
 * Parsed block from terminal output.
 */
export interface ParsedBlock {
  /** Type of the block */
  type: "thinking" | "tool" | "text" | "prompt" | "error";
  /** Content of the block */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Parser state machine states.
 */
export enum ParseState {
  /** Waiting for input prompt */
  IDLE = "idle",
  /** Extended thinking block */
  THINKING = "thinking",
  /** Tool execution block */
  TOOL_USE = "tool_use",
  /** Assistant text response */
  TEXT_OUTPUT = "text_output",
  /** Waiting for user input */
  WAITING_INPUT = "waiting_input",
  /** Response complete */
  COMPLETE = "complete",
}

/**
 * Configuration for TmuxBridge.
 */
export interface TmuxBridgeConfig {
  /** Prefix for tmux session names (default: "claude-tg") */
  sessionPrefix: string;
  /** Polling interval for output capture in ms (default: 100) */
  pollIntervalMs: number;
  /** Maximum polling time before timeout in ms (default: 300000 = 5 min) */
  maxPollTimeMs: number;
  /** Path to claude executable */
  claudePath: string;
  /** Working directory for new sessions */
  workingDir: string;
  /** Path to tmux executable (default: "tmux") */
  tmuxPath: string;
  /** Scrollback history limit (default: 10000) */
  historyLimit: number;
  /** Idle timeout before auto-cleanup in ms (default: 600000 = 10 min) */
  idleTimeoutMs: number;
}

/**
 * Lock information for concurrent access control.
 */
export interface TmuxLock {
  /** Session name being locked */
  sessionName: string;
  /** When the lock was acquired */
  acquiredAt: Date;
  /** When the lock expires */
  expiresAt: Date;
  /** Device/source info */
  deviceInfo?: string;
}

/**
 * Status of the tmux bridge.
 */
export interface TmuxBridgeStatus {
  /** Whether tmux bridge is enabled */
  enabled: boolean;
  /** Current session (if any) */
  session: TmuxSession | null;
  /** Whether currently responding to a message */
  isResponding: boolean;
  /** Current lock (if any) */
  lock: TmuxLock | null;
  /** Last activity timestamp */
  lastActivity: Date | null;
}

/**
 * Re-export StatusCallback for convenience.
 */
export type { StatusCallback };
