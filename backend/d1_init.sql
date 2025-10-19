-- Key-Value ストレージテーブル（linejs 用）
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- セッション管理テーブル
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  auth_token TEXT NOT NULL,
  refresh_token TEXT,
  user_mid TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
