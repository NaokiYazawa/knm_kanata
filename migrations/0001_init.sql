-- 時刻はすべて UTC の ISO8601 文字列で保存する (見せるときだけ JST に直す)。

CREATE TABLE sessions (
  session_key    TEXT PRIMARY KEY,   -- KANATA-<16hex>。転写ログを grep するための印でもある
  project        TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL,      -- queued | running | waiting | done | failed
  requester_id   TEXT NOT NULL,      -- Discord user id
  channel_id     TEXT NOT NULL,
  thread_id      TEXT,               -- 起動後に埋まる
  cc_session_id  TEXT,               -- Anthropic の session_01…
  cc_session_url TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX sessions_status_idx ON sessions (status, created_at);

CREATE TABLE asks (
  ask_id          TEXT PRIMARY KEY,  -- ask_<16hex>
  session_key     TEXT NOT NULL REFERENCES sessions (session_key),
  question        TEXT NOT NULL,
  options_json    TEXT NOT NULL,     -- string[] の JSON。空配列 = 自由記述のみ
  allow_free_text INTEGER NOT NULL,
  answer          TEXT,              -- NULL = 未回答
  answered_by     TEXT,
  answered_at     TEXT,
  message_id      TEXT,              -- 質問を出した Discord メッセージ
  created_at      TEXT NOT NULL
);

CREATE INDEX asks_session_idx ON asks (session_key, created_at);

-- 進捗と通知の記録。Discord に出す前でも後でも、何が起きたかはここに残す。
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  kind        TEXT NOT NULL,         -- progress | done | blocked | stop_hook | error
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX events_session_idx ON events (session_key, id);
