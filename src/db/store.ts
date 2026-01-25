/**
 * SessionStore - SQLite-based multi-device session synchronization
 *
 * Features:
 * - Multi-device session sharing
 * - Concurrent access protection via locks
 * - Message history persistence
 * - Real-time state synchronization
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface SessionData {
  session_id: string;
  user_id: number;
  title: string | null;
  working_dir: string;
  created_at: string;
  updated_at: string;
  is_active: boolean;
}

export interface MessageData {
  id?: number;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  metadata?: string; // JSON string
}

export interface SessionLock {
  user_id: number;
  locked_at: string;
  expires_at: string;
  device_info?: string;
}

export interface SessionState {
  user_id: number;
  is_processing: boolean;
  current_tool: string | null;
  last_activity: string | null;
}

/**
 * SQLite-based session store for multi-device synchronization
 */
export class SessionStore {
  private db: Database;
  private readonly LOCK_TIMEOUT_MS = 30000; // 30 seconds

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL"); // Write-Ahead Logging for better concurrency
    this.db.exec("PRAGMA foreign_keys = ON");

    // Initialize schema
    this.initSchema();
  }

  /**
   * Initialize database schema from SQL file
   */
  private initSchema(): void {
    const schemaPath = `${import.meta.dir}/schema.sql`;
    if (existsSync(schemaPath)) {
      const schema = readFileSync(schemaPath, "utf-8");
      this.db.exec(schema);
      console.log("Database schema initialized");
    } else {
      console.warn("Schema file not found, using inline schema");
      // Fallback inline schema (same as schema.sql)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id INTEGER PRIMARY KEY,
          username TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title TEXT,
          working_dir TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          is_active BOOLEAN DEFAULT 1,
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS session_locks (
          user_id INTEGER PRIMARY KEY,
          locked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          device_info TEXT
        );

        CREATE TABLE IF NOT EXISTS session_state (
          user_id INTEGER PRIMARY KEY,
          is_processing BOOLEAN DEFAULT 0,
          current_tool TEXT,
          last_activity TEXT,
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      `);
    }
  }

  // ==================== User Management ====================

  /**
   * Register or update user
   */
  upsertUser(userId: number, username?: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO users (user_id, username, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = COALESCE(?, username),
        last_seen_at = ?
    `);
    stmt.run(userId, username ?? null, now, now, username ?? null, now);
  }

  // ==================== Session Management ====================

  /**
   * Create a new session
   */
  createSession(sessionId: string, userId: number, workingDir: string, title?: string): void {
    const now = new Date().toISOString();

    // Deactivate other sessions for this user
    this.db.prepare(`
      UPDATE sessions SET is_active = 0 WHERE user_id = ?
    `).run(userId);

    // Insert new session
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_id, user_id, title, working_dir, created_at, updated_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(session_id) DO UPDATE SET
        title = COALESCE(?, title),
        updated_at = ?,
        is_active = 1
    `);
    stmt.run(sessionId, userId, title ?? null, workingDir, now, now, title ?? null, now);
  }

  /**
   * Get active session for user
   */
  getActiveSession(userId: number): SessionData | null {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1
    `);
    return stmt.get(userId) as SessionData | null;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionData | null {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE session_id = ?
    `);
    return stmt.get(sessionId) as SessionData | null;
  }

  /**
   * Update session title
   */
  updateSessionTitle(sessionId: string, title: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?
    `);
    stmt.run(title, new Date().toISOString(), sessionId);
  }

  /**
   * Deactivate all sessions for user (equivalent to /new)
   */
  deactivateUserSessions(userId: number): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET is_active = 0 WHERE user_id = ?
    `);
    stmt.run(userId);
  }

  /**
   * Get all sessions for user (for /sessions command)
   */
  getUserSessions(userId: number, limit: number = 10): SessionData[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
    `);
    return stmt.all(userId, limit) as SessionData[];
  }

  // ==================== Message History ====================

  /**
   * Save a message to history
   */
  saveMessage(message: MessageData): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, created_at, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.session_id,
      message.role,
      message.content,
      message.created_at,
      message.metadata || null
    );
  }

  /**
   * Get message history for a session
   */
  getMessages(sessionId: string, limit?: number): MessageData[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC ${limit ? `LIMIT ${limit}` : ''}
    `);
    return stmt.all(sessionId) as MessageData[];
  }

  /**
   * Get recent messages across all user sessions
   */
  getRecentMessages(userId: number, limit: number = 50): MessageData[] {
    const stmt = this.db.prepare(`
      SELECT m.* FROM messages m
      JOIN sessions s ON m.session_id = s.session_id
      WHERE s.user_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit) as MessageData[];
  }

  // ==================== Concurrency Control ====================

  /**
   * Acquire lock for user session (prevents concurrent processing)
   * Returns true if lock acquired, false if already locked
   */
  acquireLock(userId: number, deviceInfo?: string): boolean {
    // Clean up expired locks first
    this.cleanupExpiredLocks();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.LOCK_TIMEOUT_MS);

    try {
      const stmt = this.db.prepare(`
        INSERT INTO session_locks (user_id, locked_at, expires_at, device_info)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(userId, now.toISOString(), expiresAt.toISOString(), deviceInfo || null);
      return true;
    } catch (error) {
      // Lock already exists
      return false;
    }
  }

  /**
   * Release lock for user
   */
  releaseLock(userId: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM session_locks WHERE user_id = ?
    `);
    stmt.run(userId);
  }

  /**
   * Check if user session is locked
   */
  isLocked(userId: number): boolean {
    this.cleanupExpiredLocks();

    const stmt = this.db.prepare(`
      SELECT 1 FROM session_locks WHERE user_id = ? AND expires_at > ?
    `);
    const result = stmt.get(userId, new Date().toISOString());
    return result !== null;
  }

  /**
   * Get current lock info
   */
  getLock(userId: number): SessionLock | null {
    this.cleanupExpiredLocks();

    const stmt = this.db.prepare(`
      SELECT * FROM session_locks WHERE user_id = ? AND expires_at > ?
    `);
    return stmt.get(userId, new Date().toISOString()) as SessionLock | null;
  }

  /**
   * Clean up expired locks
   */
  private cleanupExpiredLocks(): void {
    const stmt = this.db.prepare(`
      DELETE FROM session_locks WHERE expires_at <= ?
    `);
    stmt.run(new Date().toISOString());
  }

  // ==================== Session State ====================

  /**
   * Update session processing state
   */
  updateState(userId: number, state: Partial<SessionState>): void {
    const now = new Date().toISOString();

    // Ensure user exists first (required for foreign key constraint)
    this.upsertUser(userId);

    const stmt = this.db.prepare(`
      INSERT INTO session_state (user_id, is_processing, current_tool, last_activity)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        is_processing = COALESCE(?, is_processing),
        current_tool = COALESCE(?, current_tool),
        last_activity = ?
    `);

    stmt.run(
      userId,
      state.is_processing ?? 0,
      state.current_tool ?? null,
      now,
      state.is_processing ?? null,
      state.current_tool ?? null,
      now
    );
  }

  /**
   * Get current session state
   */
  getState(userId: number): SessionState | null {
    const stmt = this.db.prepare(`
      SELECT * FROM session_state WHERE user_id = ?
    `);
    return stmt.get(userId) as SessionState | null;
  }

  // ==================== Utilities ====================

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database statistics
   */
  getStats() {
    const stats = {
      users: this.db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number },
      sessions: this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number },
      messages: this.db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number },
      activeLocks: this.db.prepare("SELECT COUNT(*) as count FROM session_locks WHERE expires_at > ?")
        .get(new Date().toISOString()) as { count: number },
    };

    return {
      users: stats.users.count,
      sessions: stats.sessions.count,
      messages: stats.messages.count,
      activeLocks: stats.activeLocks.count,
    };
  }
}
