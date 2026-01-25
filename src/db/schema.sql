-- Claude Telegram Bot - Multi-device Session Store
-- SQLite Schema for synchronized sessions across devices

-- Users table (Telegram users)
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Sessions table (Claude Code sessions)
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

-- Messages table (conversation history)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata TEXT, -- JSON: tool info, usage stats, etc.
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- Session locks (prevent concurrent access)
CREATE TABLE IF NOT EXISTS session_locks (
  user_id INTEGER PRIMARY KEY,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  device_info TEXT -- e.g., "Mobile", "Desktop"
);

-- Session state (current processing status)
CREATE TABLE IF NOT EXISTS session_state (
  user_id INTEGER PRIMARY KEY,
  is_processing BOOLEAN DEFAULT 0,
  current_tool TEXT,
  last_activity TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_locks_expires_at ON session_locks(expires_at);
