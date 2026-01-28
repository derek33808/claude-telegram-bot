/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 *
 * Multi-device support:
 * - Uses SQLite for session state synchronization
 * - Implements locking to prevent concurrent access
 * - Stores message history for all devices
 */

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  MCP_SERVERS,
  SAFETY_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
  DB_PATH,
  TMUX_ENABLED,
} from "./config";
import { TmuxBridge, type TmuxSession } from "./tmux";
import { formatToolStatus } from "./formatting";
import { checkPendingAskUserRequests } from "./handlers/streaming";
import { checkCommandSafety, isPathAllowed } from "./security";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
  ClaudeCodeSession,
} from "./types";
import { SessionStore } from "./db/store";

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */
// Maximum number of sessions to keep in history
const MAX_SESSIONS = 5;

// Global session store instance
const store = new SessionStore(DB_PATH);

class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;

  // Tmux bridge for persistent session mode
  private tmuxBridge: TmuxBridge | null = null;
  private tmuxSession: TmuxSession | null = null;

  // Current user context
  private currentUserId: number | null = null;
  private currentUsername: string | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  get isActive(): boolean {
    // In tmux mode, check tmux session instead of sessionId
    if (TMUX_ENABLED && this.tmuxSession) {
      return this.tmuxSession.isRunning;
    }
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    // In tmux mode, check tmux bridge status
    if (TMUX_ENABLED && this.tmuxBridge) {
      return this.tmuxBridge.getStatus().isResponding;
    }
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Get or create the TmuxBridge instance.
   */
  private getTmuxBridge(): TmuxBridge {
    if (!this.tmuxBridge) {
      this.tmuxBridge = new TmuxBridge({ workingDir: WORKING_DIR });
    }
    return this.tmuxBridge;
  }

  /**
   * Get current tmux session info (for /status command).
   */
  getTmuxStatus(): { enabled: boolean; session: TmuxSession | null; isResponding: boolean } {
    if (!TMUX_ENABLED) {
      return { enabled: false, session: null, isResponding: false };
    }
    if (!this.tmuxBridge) {
      return { enabled: true, session: null, isResponding: false };
    }
    const status = this.tmuxBridge.getStatus();
    return {
      enabled: true,
      session: status.session,
      isResponding: status.isResponding,
    };
  }

  /**
   * List available tmux sessions (for /sessions command).
   */
  async listTmuxSessions(): Promise<TmuxSession[]> {
    if (!TMUX_ENABLED) {
      return [];
    }
    const bridge = this.getTmuxBridge();
    return bridge.listSessions();
  }

  async getTmuxSessionSummary(sessionName: string): Promise<string> {
    if (!TMUX_ENABLED) return "";
    const bridge = this.getTmuxBridge();
    return bridge.getSessionSummary(sessionName);
  }

  /**
   * Attach to an existing tmux session (takeover mode).
   */
  async attachTmuxSession(sessionName: string): Promise<[boolean, string]> {
    if (!TMUX_ENABLED) {
      return [false, "Tmux bridge is not enabled"];
    }
    try {
      const bridge = this.getTmuxBridge();
      this.tmuxSession = await bridge.attachToSession(sessionName);
      return [true, `Attached to session: ${sessionName}`];
    } catch (error) {
      return [false, `Failed to attach: ${error}`];
    }
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // In tmux mode, send Ctrl+C to stop current response
    if (TMUX_ENABLED && this.tmuxBridge) {
      const status = this.tmuxBridge.getStatus();
      if (status.isResponding) {
        await this.tmuxBridge.stopResponse();
        console.log("Stop requested - sent Ctrl+C to tmux session");
        return "stopped";
      }
    }

    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Update current user context
    this.currentUserId = userId;
    this.currentUsername = username;

    // Register/update user in database
    store.upsertUser(userId, username);

    // Try to acquire lock (prevent concurrent access from multiple devices)
    const lockAcquired = store.acquireLock(userId);
    if (!lockAcquired) {
      const lock = store.getLock(userId);
      const waitTime = lock ? Math.ceil((new Date(lock.expires_at).getTime() - Date.now()) / 1000) : 30;
      throw new Error(
        `⏳ Another device is currently using Claude. Please wait ${waitTime}s or use /stop to interrupt.`
      );
    }

    try {
      // Route to tmux bridge if enabled
      if (TMUX_ENABLED) {
        return await this._sendMessageViaTmux(message, statusCallback);
      }

      return await this._sendMessageStreamingInternal(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );
    } finally {
      // Always release lock when done
      store.releaseLock(userId);
      store.updateState(userId, { is_processing: false, current_tool: null });
    }
  }

  /**
   * Send message via tmux bridge (persistent session mode).
   */
  private async _sendMessageViaTmux(
    message: string,
    statusCallback: StatusCallback
  ): Promise<string> {
    const bridge = this.getTmuxBridge();

    // Create or ensure we have an active tmux session
    if (!bridge.getCurrentSession()) {
      console.log("Creating new tmux session for Claude Code...");
      await statusCallback("tool", "Starting Claude Code session...");

      // Resume last session if we have a sessionId, otherwise create new
      this.tmuxSession = await bridge.createSession(
        undefined,
        this.sessionId || undefined
      );

      console.log(`Tmux session created: ${this.tmuxSession.sessionName}`);
    }

    // Update processing state
    if (this.currentUserId) {
      store.updateState(this.currentUserId, { is_processing: true });
    }

    try {
      // Send message via tmux
      const response = await bridge.sendMessage(message, statusCallback);

      // Update activity tracking
      this.lastActivity = new Date();
      this.lastMessage = message;

      // Save to database if we have user context
      if (this.currentUserId && this.tmuxSession) {
        const now = new Date().toISOString();

        // Use tmux session name as a pseudo session ID for tracking
        const tmuxSessionId = `tmux-${this.tmuxSession.sessionName}`;

        // Ensure session record exists before saving messages (fixes foreign key constraint)
        store.createSession(
          tmuxSessionId,
          this.currentUserId,
          WORKING_DIR,
          `Tmux: ${this.tmuxSession.sessionName}`
        );

        store.saveMessage({
          session_id: tmuxSessionId,
          role: "user",
          content: message,
          created_at: now,
        });

        if (response) {
          store.saveMessage({
            session_id: tmuxSessionId,
            role: "assistant",
            content: response,
            created_at: now,
          });
        }
      }

      return response || "No response from Claude.";
    } finally {
      if (this.currentUserId) {
        store.updateState(this.currentUserId, { is_processing: false, current_tool: null });
      }
    }
  }

  /**
   * Internal implementation of sendMessageStreaming (after lock acquired)
   */
  private async _sendMessageStreamingInternal(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    // Update processing state
    store.updateState(userId, { is_processing: true });

    // Load active session from database (for multi-device sync)
    const activeSession = store.getActiveSession(userId);
    if (activeSession && !this.sessionId) {
      this.sessionId = activeSession.session_id;
      this.conversationTitle = activeSession.title;
      console.log(`Loaded active session from DB: ${this.sessionId.slice(0, 8)}...`);
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString(
        "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }
      )}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: "claude-sonnet-4-5",
      cwd: WORKING_DIR,
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: SAFETY_PROMPT,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
    };

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      });

      // Process streaming response
      for await (const event of queryInstance) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);

          // Save to both legacy file and database
          this.saveSession();

          // Create session in database
          if (this.currentUserId) {
            store.createSession(this.sessionId, this.currentUserId, WORKING_DIR, this.conversationTitle ?? undefined);
          }
        }

        // Handle different message types
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  console.warn(`BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
                }
              }

              // Safety check for file operations
              if (["Read", "Write", "Edit"].includes(toolName)) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  // Allow reads from temp paths and .claude directories
                  const isTmpRead =
                    toolName === "Read" &&
                    (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    console.warn(
                      `BLOCKED: File access outside allowed paths: ${filePath}`
                    );
                    await statusCallback("tool", `Access denied: ${filePath}`);
                    throw new Error(`File access blocked: ${filePath}`);
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user - the buttons are self-explanatory
              if (!toolName.startsWith("mcp__ask-user")) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }
            }

            // Text content
            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            break;
          }
        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
        }
      }

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (
        isCleanupError &&
        (queryCompleted || askUserTriggered || this.stopRequested)
      ) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // Save message history to database
    if (this.sessionId && this.currentUserId) {
      const now = new Date().toISOString();

      // Save user message
      store.saveMessage({
        session_id: this.sessionId,
        role: "user",
        content: message,
        created_at: now,
      });

      // Save assistant response (if not ask_user)
      if (!askUserTriggered) {
        const assistantResponse = responseParts.join("");
        if (assistantResponse) {
          store.saveMessage({
            session_id: this.sessionId,
            role: "assistant",
            content: assistantResponse,
            created_at: now,
            metadata: this.lastUsage ? JSON.stringify(this.lastUsage) : undefined,
          });
        }
      }

      // Update session timestamp
      store.createSession(this.sessionId, this.currentUserId, WORKING_DIR, this.conversationTitle ?? undefined);
    }

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   * In tmux mode, marks session for cleanup based on creation type.
   */
  async kill(): Promise<void> {
    // In tmux mode, mark session for exit (triggers cleanup based on creation type)
    if (TMUX_ENABLED && this.tmuxBridge) {
      this.tmuxBridge.markForExit();
      this.tmuxSession = null;
      console.log("Tmux session marked for exit");
    }

    // Deactivate in database (for multi-device sync)
    if (this.currentUserId) {
      store.deactivateUserSessions(this.currentUserId);
    }

    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    console.log("Session cleared");
  }

  /**
   * Kill a specific tmux session by name.
   */
  async killTmuxSession(sessionName: string): Promise<[boolean, string]> {
    if (!TMUX_ENABLED) {
      return [false, "Tmux bridge is not enabled"];
    }
    try {
      const bridge = this.getTmuxBridge();
      await bridge.killSession(sessionName);

      // Clear current session if it was the one killed
      if (this.tmuxSession?.sessionName === sessionName) {
        this.tmuxSession = null;
      }

      return [true, `Session ${sessionName} killed`];
    } catch (error) {
      return [false, `Failed to kill session: ${error}`];
    }
  }

  /**
   * Save session to disk for resume after restart.
   * Saves to multi-session history format.
   */
  saveSession(): void {
    if (!this.sessionId) return;

    try {
      // Load existing session history
      const history = this.loadSessionHistory();

      // Create new session entry
      const newSession: SavedSession = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: this.conversationTitle || "Sessione senza titolo",
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last MAX_SESSIONS
      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      // Save
      Bun.write(SESSION_FILE, JSON.stringify(history, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved sessions for display.
   * Now uses database for multi-device sync.
   */
  getSessionList(): SavedSession[] {
    // If we have a current user, get from database
    if (this.currentUserId) {
      const dbSessions = store.getUserSessions(this.currentUserId, MAX_SESSIONS);
      return dbSessions.map(s => ({
        session_id: s.session_id,
        saved_at: s.updated_at,
        working_dir: s.working_dir,
        title: s.title || "Untitled session",
      }));
    }

    // Fallback to legacy file-based sessions
    const history = this.loadSessionHistory();
    return history.sessions.filter(
      (s) => !s.working_dir || s.working_dir === WORKING_DIR
    );
  }

  /**
   * Get message history for current session
   */
  getMessageHistory(limit?: number): string {
    if (!this.sessionId) {
      return "No active session";
    }

    const messages = store.getMessages(this.sessionId, limit);
    if (messages.length === 0) {
      return "No message history found";
    }

    return messages
      .map(m => {
        const timestamp = new Date(m.created_at).toLocaleString();
        const role = m.role === "user" ? "👤 User" : "🤖 Claude";
        return `[${timestamp}] ${role}:\n${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`;
      })
      .join("\n\n---\n\n");
  }

  /**
   * Get database statistics (for /health command)
   */
  getDbStats() {
    return store.getStats();
  }

  /**
   * Resume a specific session by ID.
   */
  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Sessione non trovata"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [
        false,
        `Sessione per directory diversa: ${sessionData.working_dir}`,
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Ripresa sessione: "${sessionData.title}"`,
    ];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "Nessuna sessione salvata"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }

  /**
   * Get list of Claude Code sessions from ~/.claude/projects/
   */
  getClaudeCodeSessions(): ClaudeCodeSession[] {
    try {
      // Convert working directory to Claude's project path format
      // Claude replaces both / and _ with -
      const projectPathEncoded = WORKING_DIR.replace(/[/_]/g, "-");
      const sessionsIndexPath = `${process.env.HOME}/.claude/projects/${projectPathEncoded}/sessions-index.json`;
      console.log(`Looking for sessions at: ${sessionsIndexPath}`);

      const file = Bun.file(sessionsIndexPath);
      if (!file.size) {
        return [];
      }

      const text = readFileSync(sessionsIndexPath, "utf-8");
      const data = JSON.parse(text) as { version: number; entries: ClaudeCodeSession[] };

      // Filter active sessions (not sidechains), sort by modified time (newest first)
      return data.entries
        .filter(s => !s.isSidechain && s.messageCount > 0)
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
        .slice(0, 10); // Return top 10
    } catch (error) {
      console.warn("Failed to load Claude Code sessions:", error);
      return [];
    }
  }

  /**
   * Resume a Claude Code session by ID.
   */
  resumeClaudeCodeSession(sessionId: string): [success: boolean, message: string] {
    const sessions = this.getClaudeCodeSessions();
    const sessionData = sessions.find((s) => s.sessionId === sessionId);

    if (!sessionData) {
      return [false, "Claude Code session not found"];
    }

    this.sessionId = sessionData.sessionId;
    this.conversationTitle = sessionData.summary || sessionData.firstPrompt?.slice(0, 50);
    this.lastActivity = new Date();

    console.log(
      `Resumed Claude Code session ${sessionData.sessionId.slice(0, 8)}... - "${this.conversationTitle}"`
    );

    return [
      true,
      `已接管会话: "${this.conversationTitle}"`,
    ];
  }
}

// Global session instance
export const session = new ClaudeSession();
