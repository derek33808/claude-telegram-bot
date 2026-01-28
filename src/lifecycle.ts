/**
 * Lifecycle Manager for Claude Telegram Bot.
 *
 * Handles automatic idle detection and graceful shutdown.
 * When enabled, the bot will automatically exit after a period of inactivity
 * (no Telegram messages + no active claude tmux sessions + no running requests).
 */

import { execSync } from "child_process";
import { unlinkSync, writeFileSync, existsSync } from "fs";
import type { RunnerHandle } from "@grammyjs/runner";
import type { Bot } from "grammy";
import {
  BOT_AUTO_LIFECYCLE,
  BOT_IDLE_TIMEOUT,
  BOT_IDLE_CHECK_INTERVAL,
  BOT_PID_FILE,
  ALLOWED_USERS,
} from "./config";
import { TMUX_SESSION_PREFIX } from "./tmux/config";

export class LifecycleManager {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastTelegramActivity: Date;
  private runner: RunnerHandle | null = null;
  private bot: Bot | null = null;
  private shuttingDown = false;

  constructor() {
    this.lastTelegramActivity = new Date();
  }

  /**
   * Initialize the lifecycle manager with runner and bot references.
   * Writes PID file and starts idle checking if auto-lifecycle is enabled.
   */
  start(runner: RunnerHandle, bot: Bot): void {
    this.runner = runner;
    this.bot = bot;

    // Write PID file
    this.writePidFile();

    if (!BOT_AUTO_LIFECYCLE) {
      console.log("Auto-lifecycle disabled (BOT_AUTO_LIFECYCLE=false)");
      return;
    }

    console.log(
      `Auto-lifecycle enabled: idle timeout=${BOT_IDLE_TIMEOUT}ms, check interval=${BOT_IDLE_CHECK_INTERVAL}ms`
    );

    // Start periodic idle check
    this.checkInterval = setInterval(() => {
      this.checkIdleConditions();
    }, BOT_IDLE_CHECK_INTERVAL);

    // Start initial idle timer
    this.resetIdleTimer();
  }

  /**
   * Reset the idle timer. Called on every Telegram message.
   */
  resetIdleTimer(): void {
    this.lastTelegramActivity = new Date();

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!BOT_AUTO_LIFECYCLE) return;

    this.idleTimer = setTimeout(() => {
      this.checkIdleConditions();
    }, BOT_IDLE_TIMEOUT);
  }

  /**
   * Check whether the bot should auto-exit.
   * Conditions (ALL must be true):
   * 1. Telegram idle > BOT_IDLE_TIMEOUT
   * 2. No active claude-tg- prefixed tmux sessions
   * 3. Not currently shutting down
   */
  private async checkIdleConditions(): Promise<void> {
    if (this.shuttingDown) return;

    const idleMs = Date.now() - this.lastTelegramActivity.getTime();
    if (idleMs < BOT_IDLE_TIMEOUT) return;

    // Check for active bot-created tmux sessions
    const activeSessions = this.getActiveBotTmuxSessions();
    if (activeSessions.length > 0) {
      console.log(
        `Idle check: Telegram idle ${Math.round(idleMs / 1000)}s, but ${activeSessions.length} active tmux session(s): ${activeSessions.join(", ")}`
      );
      return;
    }

    console.log(
      `Idle check: Telegram idle ${Math.round(idleMs / 1000)}s, no active tmux sessions. Initiating shutdown.`
    );
    await this.gracefulShutdown();
  }

  /**
   * Get list of active tmux sessions with the bot's prefix (claude-tg-).
   * Only checks sessions created by this bot.
   */
  private getActiveBotTmuxSessions(): string[] {
    try {
      const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!output) return [];

      return output
        .split("\n")
        .filter((name) => name.startsWith(TMUX_SESSION_PREFIX));
    } catch {
      // tmux not running or not available
      return [];
    }
  }

  /**
   * Graceful shutdown: notify user, stop runner, clean up.
   */
  async gracefulShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    console.log("Graceful shutdown initiated...");

    // Clear timers
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Send Telegram notification to first allowed user
    if (this.bot && ALLOWED_USERS.length > 0) {
      try {
        await this.bot.api.sendMessage(
          ALLOWED_USERS[0]!,
          "Bot auto-shutdown due to idle timeout. It will auto-restart when Claude CLI is launched in tmux."
        );
      } catch (e) {
        console.warn("Failed to send shutdown notification:", e);
      }
    }

    // Stop the runner
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }

    // Delete PID file
    this.removePidFile();

    // Exit
    process.exit(0);
  }

  /**
   * Write PID file for external scripts to check.
   */
  private writePidFile(): void {
    try {
      writeFileSync(BOT_PID_FILE, process.pid.toString(), "utf-8");
      console.log(`PID file written: ${BOT_PID_FILE} (PID: ${process.pid})`);
    } catch (e) {
      console.warn("Failed to write PID file:", e);
    }
  }

  /**
   * Remove PID file on exit.
   */
  removePidFile(): void {
    try {
      if (existsSync(BOT_PID_FILE)) {
        unlinkSync(BOT_PID_FILE);
        console.log("PID file removed");
      }
    } catch (e) {
      console.warn("Failed to remove PID file:", e);
    }
  }
}
