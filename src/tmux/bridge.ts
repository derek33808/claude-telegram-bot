/**
 * TmuxBridge - Core class for tmux-based Claude Code interaction.
 *
 * Manages tmux sessions, sends messages, captures output, and converts
 * terminal output to structured events for Telegram.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type {
  TmuxSession,
  TmuxBridgeConfig,
  TmuxLock,
  TmuxBridgeStatus,
  StatusCallback,
} from "./types";
import {
  getDefaultConfig,
  TMUX_DATA_DIR,
  TMUX_LOCK_FILE,
  TMUX_SESSION_FILE,
  TMUX_LOCK_TIMEOUT,
  TMUX_IDLE_TIMEOUT,
  TMUX_CLI_WATCH,
} from "./config";
import { TerminalOutputParser } from "./parser";
import { ParseState } from "./types";

/**
 * TmuxBridge manages Claude Code sessions via tmux.
 */
export class TmuxBridge {
  private config: TmuxBridgeConfig;
  private currentSession: TmuxSession | null = null;
  private pollAbortController: AbortController | null = null;
  private cleanupTimers: Map<string, NodeJS.Timeout> = new Map();

  // CLI watcher state
  private cliWatcherTimer: NodeJS.Timeout | null = null;
  private lastKnownPaneContent: string = "";
  private cliWatcherCallback: ((content: string) => void) | null = null;

  constructor(config: Partial<TmuxBridgeConfig> & { workingDir: string }) {
    this.config = {
      ...getDefaultConfig(config.workingDir),
      ...config,
    };

    // Ensure data directory exists
    if (!existsSync(TMUX_DATA_DIR)) {
      mkdirSync(TMUX_DATA_DIR, { recursive: true });
    }
  }

  // ==================== Session Management ====================

  /**
   * Create a new tmux session with Claude Code.
   *
   * @param sessionName - Optional custom session name
   * @param resumeSessionId - Optional Claude session ID to resume
   * @returns The created TmuxSession
   */
  async createSession(
    sessionName?: string,
    resumeSessionId?: string
  ): Promise<TmuxSession> {
    const name = sessionName || `${this.config.sessionPrefix}-${Date.now()}`;

    // Build claude command
    let claudeCmd = this.config.claudePath;
    if (resumeSessionId) {
      claudeCmd += ` --resume ${resumeSessionId}`;
    }

    // Create tmux session with claude running
    await this.executeTmux([
      "new-session",
      "-d", // Detached
      "-s", name, // Session name
      "-c", this.config.workingDir, // Working directory
      "-x", "200", // Width
      "-y", "50", // Height
      claudeCmd, // Command to run
    ]);

    // Set history limit
    await this.executeTmux([
      "set-option",
      "-t", name,
      "history-limit", String(this.config.historyLimit),
    ]);

    // Create session object first (needed for capturePane)
    this.currentSession = {
      sessionName: name,
      windowId: "0",
      paneId: "0",
      workingDir: this.config.workingDir,
      isRunning: true,
      createdBy: "telegram",
      isOwned: true,
      markedForExit: false,
      lastActivity: new Date(),
    };

    // Save session metadata
    this.saveSessionMetadata();

    // Wait for Claude CLI to fully initialize (detect ❯ prompt)
    const maxWait = 30000; // 30 seconds max
    const startWait = Date.now();
    let ready = false;
    while (Date.now() - startWait < maxWait) {
      await Bun.sleep(1000);
      const pane = await this.capturePane();
      // Claude CLI shows ❯ prompt when ready for input
      if (pane.includes("❯")) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      console.warn(`Claude CLI may not be fully initialized after ${maxWait}ms`);
    }

    console.log(`Created tmux session: ${name}`);
    return this.currentSession;
  }

  /**
   * Attach to an existing tmux session.
   *
   * @param sessionName - Name of the session to attach to
   * @returns The attached TmuxSession
   */
  async attachToSession(sessionName: string): Promise<TmuxSession> {
    // Verify session exists
    const sessions = await this.listSessions();
    const target = sessions.find((s) => s.sessionName === sessionName);

    if (!target) {
      throw new Error(`Session not found: ${sessionName}`);
    }

    // Update ownership
    target.isOwned = true;
    target.lastActivity = new Date();
    this.currentSession = target;

    // Set history-limit for taken-over sessions too
    try {
      await this.executeTmux([
        "set-option",
        "-t", sessionName,
        "history-limit", String(this.config.historyLimit),
      ]);
    } catch {
      console.warn(`Failed to set history-limit on ${sessionName}`);
    }

    // Save metadata
    this.saveSessionMetadata();

    console.log(`Attached to tmux session: ${sessionName}`);
    return this.currentSession;
  }

  /**
   * List all tmux sessions (both telegram-created and CLI).
   */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.executeTmux([
        "list-sessions",
        "-F",
        "#{session_name}:#{window_id}:#{pane_id}:#{pane_current_path}:#{pane_pid}",
      ]);

      const sessions: TmuxSession[] = [];
      const savedMetadata = this.loadSessionMetadata();

      for (const line of output.trim().split("\n").filter(Boolean)) {
        const [sessionName, windowId, paneId, path] = line.split(":");
        if (!sessionName) continue;

        // Show all tmux sessions (not just Claude-prefixed ones)
        // This allows taking over any session where Claude might be running
        // Sessions with "claude" in name are marked as Claude-created
        const isClaudeSession =
          sessionName.startsWith(this.config.sessionPrefix) ||
          sessionName.toLowerCase().includes("claude");

        // No longer skip non-Claude sessions - show all for takeover

        // Get saved metadata or create default
        const saved = savedMetadata[sessionName];

        sessions.push({
          sessionName,
          windowId: windowId || "0",
          paneId: paneId || "0",
          workingDir: path || this.config.workingDir,
          isRunning: true,
          createdBy: saved?.createdBy || "cli",
          isOwned: saved?.isOwned || false,
          markedForExit: saved?.markedForExit || false,
          markedAt: saved?.markedAt ? new Date(saved.markedAt) : undefined,
          lastActivity: saved?.lastActivity
            ? new Date(saved.lastActivity)
            : new Date(),
        });
      }

      return sessions;
    } catch {
      // No sessions or tmux not running
      return [];
    }
  }

  /**
   * Kill a tmux session.
   */
  async killSession(sessionName: string): Promise<void> {
    try {
      await this.executeTmux(["kill-session", "-t", sessionName]);
      console.log(`Killed tmux session: ${sessionName}`);

      // Clear current session if it was killed
      if (this.currentSession?.sessionName === sessionName) {
        this.currentSession = null;
      }

      // Remove from metadata
      const metadata = this.loadSessionMetadata();
      delete metadata[sessionName];
      this.saveSessionMetadataRaw(metadata);

      // Clear cleanup timer
      const timer = this.cleanupTimers.get(sessionName);
      if (timer) {
        clearTimeout(timer);
        this.cleanupTimers.delete(sessionName);
      }
    } catch (error) {
      console.warn(`Failed to kill session ${sessionName}:`, error);
    }
  }

  /**
   * Get current session.
   */
  getCurrentSession(): TmuxSession | null {
    return this.currentSession;
  }

  // ==================== Message Handling ====================

  /**
   * Send a message to Claude Code via tmux.
   *
   * @param message - The user message to send
   * @param statusCallback - Callback for streaming status updates
   * @returns The final response text
   */
  async sendMessage(
    message: string,
    statusCallback: StatusCallback
  ): Promise<string> {
    if (!this.currentSession) {
      throw new Error("No active tmux session");
    }

    // Acquire lock
    const lock = await this.acquireLock(this.currentSession.sessionName);
    if (!lock) {
      throw new Error("Failed to acquire lock - another operation in progress");
    }

    try {
      // Send the message
      await this.sendKeys(message);
      await this.sendKeys("Enter");

      // Update activity
      this.currentSession.lastActivity = new Date();
      this.saveSessionMetadata();

      // Wait a moment for Claude to start processing
      await Bun.sleep(500);

      // Create parser and poll for response
      // Pass the sent message so we can locate the response after it
      const parser = new TerminalOutputParser();
      return await this.pollForResponse(parser, statusCallback, message);
    } finally {
      // Always release lock
      this.releaseLock(this.currentSession.sessionName);
    }
  }

  /**
   * Stop the current response (send Ctrl+C).
   */
  async stopResponse(): Promise<void> {
    if (!this.currentSession) return;

    // Abort polling
    if (this.pollAbortController) {
      this.pollAbortController.abort();
    }

    // Send Ctrl+C
    await this.executeTmux([
      "send-keys",
      "-t",
      `${this.currentSession.sessionName}:${this.currentSession.windowId}.${this.currentSession.paneId}`,
      "C-c",
    ]);

    console.log("Sent Ctrl+C to tmux session");
  }

  /**
   * Mark session for exit (will be cleaned up after timeout).
   */
  markForExit(): void {
    if (!this.currentSession) return;

    // Only mark telegram-created sessions for auto-cleanup
    if (this.currentSession.createdBy === "telegram") {
      this.currentSession.markedForExit = true;
      this.currentSession.markedAt = new Date();
      this.currentSession.isOwned = false;
      this.saveSessionMetadata();

      // Schedule cleanup
      const sessionName = this.currentSession.sessionName;
      console.log(
        `Session ${sessionName} marked for exit, will cleanup in ${TMUX_IDLE_TIMEOUT / 1000}s`
      );

      const timer = setTimeout(async () => {
        await this.cleanupSession(sessionName);
      }, TMUX_IDLE_TIMEOUT);

      this.cleanupTimers.set(sessionName, timer);
    } else {
      // CLI session - just release ownership
      this.currentSession.isOwned = false;
      this.saveSessionMetadata();
      console.log(`Released control of CLI session: ${this.currentSession.sessionName}`);
    }

    this.currentSession = null;
  }

  /**
   * Cleanup a marked session if it's still marked.
   */
  private async cleanupSession(sessionName: string): Promise<void> {
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.sessionName === sessionName);

    if (session?.markedForExit) {
      console.log(`Auto-cleaning up session: ${sessionName}`);
      await this.killSession(sessionName);
    }

    this.cleanupTimers.delete(sessionName);
  }

  // ==================== Internal Methods ====================

  /**
   * Execute a tmux command.
   */
  private async executeTmux(args: string[]): Promise<string> {
    const proc = Bun.spawn([this.config.tmuxPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tmux ${args[0]} failed: ${stderr || output}`);
    }

    return output;
  }

  /**
   * Send keys to tmux pane.
   */
  private async sendKeys(text: string): Promise<void> {
    if (!this.currentSession) return;

    const target = `${this.currentSession.sessionName}:${this.currentSession.windowId}.${this.currentSession.paneId}`;

    if (text === "Enter") {
      await this.executeTmux(["send-keys", "-t", target, "Enter"]);
    } else {
      // For regular text, use literal flag to avoid interpretation
      await this.executeTmux(["send-keys", "-t", target, "-l", text]);
    }
  }

  /**
   * Capture tmux pane content.
   */
  /**
   * Capture pane content for any session by name (for summaries).
   */
  async capturePaneByName(sessionName: string, lines: number = 30): Promise<string> {
    try {
      return await this.executeTmux([
        "capture-pane", "-t", `${sessionName}:0.0`, "-p", "-S", `-${lines}`,
      ]);
    } catch {
      return "";
    }
  }

  /**
   * Get a short summary of recent activity in a tmux session.
   */
  async getSessionSummary(sessionName: string): Promise<string> {
    const raw = await this.capturePaneByName(sessionName, 50);
    if (!raw) return "（无法读取）";

    // Find last user input (❯) and response (⏺)
    const lines = raw.split("\n");
    let lastInput = "";
    let lastResponse = "";

    for (const line of lines) {
      if (line.match(/^❯\s+.+/)) {
        lastInput = line.replace(/^❯\s+/, "").trim();
      }
      if (line.match(/^⏺\s+(.+)/)) {
        lastResponse = line.replace(/^⏺\s+/, "").trim();
      }
    }

    if (lastInput) {
      const inputPreview = lastInput.length > 20 ? lastInput.slice(0, 17) + "..." : lastInput;
      const responsePreview = lastResponse
        ? (lastResponse.length > 25 ? lastResponse.slice(0, 22) + "..." : lastResponse)
        : "...";
      return `💬 ${inputPreview} → ${responsePreview}`;
    }
    return "（空会话）";
  }

  private async capturePane(historyLines?: number): Promise<string> {
    if (!this.currentSession) return "";

    const target = `${this.currentSession.sessionName}:${this.currentSession.windowId}.${this.currentSession.paneId}`;
    const lines = historyLines || this.config.historyLimit;

    const output = await this.executeTmux([
      "capture-pane",
      "-t", target,
      "-p", // Print to stdout
      "-S", `-${lines}`, // Start from N lines ago
    ]);

    return output;
  }

  /**
   * Poll for response completion.
   *
   * State machine:
   * 1. Wait for processing indicator (✽) - Claude started
   * 2. Wait for response (⏺) and completion (❯ alone)
   */
  private async pollForResponse(
    parser: TerminalOutputParser,
    statusCallback: StatusCallback,
    sentMessage?: string
  ): Promise<string> {
    const startTime = Date.now();
    let lastOutput = "";
    let sawProcessing = false;
    let sawResponse = false;

    // Stable content tracking: remember the last successful slice anchor
    let lastSliceAnchor: string | null = sentMessage || null;
    let lastSlicedContent: string = "";

    this.pollAbortController = new AbortController();

    try {
      while (true) {
        // Check timeout
        if (Date.now() - startTime > this.config.maxPollTimeMs) {
          throw new Error("Response timeout");
        }

        // Check abort
        if (this.pollAbortController.signal.aborted) {
          throw new Error("Response cancelled");
        }

        // Capture current pane content
        const paneContent = await this.capturePane();

        // Only process if content changed
        if (paneContent !== lastOutput) {
          lastOutput = paneContent;

          // Extract content AFTER the sent message to only look at the response
          let newContent = paneContent;
          if (lastSliceAnchor) {
            const msgIndex = paneContent.lastIndexOf(lastSliceAnchor);
            if (msgIndex >= 0) {
              newContent = paneContent.slice(msgIndex + lastSliceAnchor.length);
              lastSlicedContent = newContent;
            } else {
              // Anchor scrolled out of scrollback - use diff-based fallback
              // Find how much of the previous sliced content is still at the end of pane
              if (lastSlicedContent) {
                // Look for overlap: find the tail of lastSlicedContent in new paneContent
                const tailLen = Math.min(lastSlicedContent.length, 500);
                const tail = lastSlicedContent.slice(-tailLen);
                const tailIdx = paneContent.lastIndexOf(tail);
                if (tailIdx >= 0) {
                  // Content after the known tail is the truly new content
                  newContent = paneContent.slice(tailIdx);
                  lastSlicedContent = newContent;
                } else {
                  // Complete discontinuity - reset parser and use full pane
                  console.warn("Content anchor lost and no overlap found, resetting parser");
                  parser.resetProcessedLength();
                  newContent = paneContent;
                  lastSlicedContent = newContent;
                }
              } else {
                newContent = paneContent;
                lastSlicedContent = newContent;
              }
            }
          }

          // If parser was in COMPLETE state but content changed, revoke completion
          // This handles the case where Claude shows a prompt briefly during tool
          // execution but then continues with more output
          if (parser.getState() === ParseState.COMPLETE) {
            parser.revokeCompletion();
            console.log("Content changed after completion detected - revoking completion");
          }

          // Check for processing indicator (Claude started working)
          if (!sawProcessing && newContent.includes("✽")) {
            sawProcessing = true;
            console.log("Claude is processing...");
            await statusCallback("thinking", "Processing...");
          }

          // Check for response indicator (Claude responding)
          if (!sawResponse && newContent.includes("⏺")) {
            sawResponse = true;
            console.log("Claude is responding...");
            parser.reset();
          }

          // Only start parsing after we've seen either processing or response
          if (sawProcessing || sawResponse) {
            // Feed only content after the user message to parser
            const blocks = parser.feed(newContent);

            // Emit callbacks for each block
            for (const block of blocks) {
              await this.emitStatusCallback(block, statusCallback);
            }

            // Check completion only after we've seen the response
            if (sawResponse && parser.isComplete()) {
              const response = parser.getTextResponse();
              console.log(`Response complete. Text: "${response.slice(0, 100)}"`);
              // Update watcher baseline
              this.lastKnownPaneContent = paneContent;
              await statusCallback("done", "");
              return response;
            }
          }
        }

        // Wait before next poll
        await Bun.sleep(this.config.pollIntervalMs);
      }
    } finally {
      this.pollAbortController = null;
    }
  }

  /**
   * Emit status callback based on parsed block.
   */
  private async emitStatusCallback(
    block: { type: string; content: string },
    statusCallback: StatusCallback
  ): Promise<void> {
    switch (block.type) {
      case "thinking":
        await statusCallback("thinking", block.content);
        break;
      case "tool":
        await statusCallback("tool", block.content);
        break;
      case "text":
        if (block.content.trim()) {
          await statusCallback("text", block.content, 0);
        }
        break;
      case "error":
        await statusCallback("tool", `Error: ${block.content}`);
        break;
      case "prompt":
        // Prompt detected, response should be complete soon
        break;
    }
  }

  // ==================== Lock Management ====================

  /**
   * Acquire lock for a session.
   */
  private async acquireLock(sessionName: string): Promise<TmuxLock | null> {
    const locks = this.loadLocks();

    // Check for existing valid lock
    const existing = locks[sessionName];
    if (existing && new Date(existing.expiresAt) > new Date()) {
      return null; // Lock held by someone else
    }

    // Create new lock
    const lock: TmuxLock = {
      sessionName,
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + TMUX_LOCK_TIMEOUT),
      deviceInfo: "telegram-bot",
    };

    locks[sessionName] = lock;
    this.saveLocks(locks);

    return lock;
  }

  /**
   * Release lock for a session.
   */
  private releaseLock(sessionName: string): void {
    const locks = this.loadLocks();
    delete locks[sessionName];
    this.saveLocks(locks);
  }

  /**
   * Load locks from file.
   */
  private loadLocks(): Record<string, TmuxLock> {
    try {
      if (existsSync(TMUX_LOCK_FILE)) {
        return JSON.parse(readFileSync(TMUX_LOCK_FILE, "utf-8"));
      }
    } catch {
      // Ignore errors
    }
    return {};
  }

  /**
   * Save locks to file.
   */
  private saveLocks(locks: Record<string, TmuxLock>): void {
    writeFileSync(TMUX_LOCK_FILE, JSON.stringify(locks, null, 2));
  }

  // ==================== Session Metadata ====================

  /**
   * Save current session metadata.
   */
  private saveSessionMetadata(): void {
    if (!this.currentSession) return;

    const metadata = this.loadSessionMetadata();
    metadata[this.currentSession.sessionName] = {
      createdBy: this.currentSession.createdBy,
      isOwned: this.currentSession.isOwned,
      markedForExit: this.currentSession.markedForExit,
      markedAt: this.currentSession.markedAt?.toISOString(),
      lastActivity: this.currentSession.lastActivity.toISOString(),
    };
    this.saveSessionMetadataRaw(metadata);
  }

  /**
   * Load session metadata from file.
   */
  private loadSessionMetadata(): Record<string, {
    createdBy: "telegram" | "cli";
    isOwned: boolean;
    markedForExit: boolean;
    markedAt?: string;
    lastActivity: string;
  }> {
    try {
      if (existsSync(TMUX_SESSION_FILE)) {
        return JSON.parse(readFileSync(TMUX_SESSION_FILE, "utf-8"));
      }
    } catch {
      // Ignore errors
    }
    return {};
  }

  /**
   * Save session metadata to file.
   */
  private saveSessionMetadataRaw(metadata: Record<string, unknown>): void {
    writeFileSync(TMUX_SESSION_FILE, JSON.stringify(metadata, null, 2));
  }

  // ==================== Status ====================

  // ==================== CLI Activity Watcher ====================

  /**
   * Start watching for CLI-side activity (commands typed directly in tmux).
   * When new ⏺ responses are detected that weren't triggered by sendMessage(),
   * the callback is invoked with the new content.
   *
   * @param callback - Called with new response content from CLI activity
   */
  startCliWatcher(callback: (content: string) => void): void {
    if (!TMUX_CLI_WATCH) {
      console.log("CLI watcher disabled (TMUX_CLI_WATCH=false)");
      return;
    }
    if (this.cliWatcherTimer) {
      console.log("CLI watcher already running");
      return;
    }

    this.cliWatcherCallback = callback;
    console.log("Starting CLI activity watcher...");

    // Capture initial baseline
    this.capturePane().then((content) => {
      this.lastKnownPaneContent = content;
    }).catch(() => {
      console.warn("CLI watcher: failed to capture initial baseline");
    });

    let watcherRunning = false;
    this.cliWatcherTimer = setInterval(async () => {
      // Don't watch while we're actively polling for a response
      if (this.pollAbortController) return;
      if (!this.currentSession) return;
      // Re-entrancy guard
      if (watcherRunning) return;
      watcherRunning = true;

      try {
        const paneContent = await this.capturePane();
        if (paneContent === this.lastKnownPaneContent) return;

        const oldContent = this.lastKnownPaneContent;
        this.lastKnownPaneContent = paneContent;

        // Detect new ⏺ responses that appeared since last check
        // Find content that's new (not in old content)
        const oldLines = new Set(oldContent.split("\n").map(l => l.trim()).filter(Boolean));
        const newLines = paneContent.split("\n");
        const newResponseLines: string[] = [];
        let inNewResponse = false;

        for (const line of newLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Skip lines we already knew about
          if (oldLines.has(trimmed) && !inNewResponse) continue;

          // Detect new response block
          if (/^⏺\s+/.test(line)) {
            inNewResponse = true;
            newResponseLines.push(trimmed);
          } else if (inNewResponse) {
            // Check if this is a new prompt (end of response)
            if (/^❯/.test(line)) {
              inNewResponse = false;
            } else {
              newResponseLines.push(trimmed);
            }
          }
        }

        if (newResponseLines.length > 0 && this.cliWatcherCallback) {
          const newContent = newResponseLines.join("\n");
          console.log(`CLI watcher detected new activity: ${newContent.slice(0, 80)}...`);
          this.cliWatcherCallback(newContent);
        }
      } catch {
        // Ignore errors in watcher (session might have been killed)
      } finally {
        watcherRunning = false;
      }
    }, 2000); // Check every 2 seconds
  }

  /**
   * Stop the CLI activity watcher.
   */
  stopCliWatcher(): void {
    if (this.cliWatcherTimer) {
      clearInterval(this.cliWatcherTimer);
      this.cliWatcherTimer = null;
      this.cliWatcherCallback = null;
      console.log("CLI watcher stopped");
    }
  }

  /**
   * Check if CLI watcher is running.
   */
  isCliWatcherRunning(): boolean {
    return this.cliWatcherTimer !== null;
  }

  /**
   * Get bridge status.
   */
  getStatus(): TmuxBridgeStatus {
    const locks = this.loadLocks();
    const currentLock = this.currentSession
      ? locks[this.currentSession.sessionName]
      : null;

    return {
      enabled: true,
      session: this.currentSession,
      isResponding: this.pollAbortController !== null,
      lock: currentLock || null,
      lastActivity: this.currentSession?.lastActivity || null,
    };
  }
}
