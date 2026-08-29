-- スレッドに素で書かれた文を受けるための追加。

-- 素の文が届いたとき「このスレッドは誰の会話か」を毎回引くので索引を張る。
CREATE INDEX sessions_thread_idx ON sessions (thread_id, created_at);

-- Claude が «聞きに来ていない» 間に書かれた文の置き場。
--
-- ターミナルの Claude Code で作業中に打った文が «キューに入って次のターンで届く» のと同じ。
-- 走っているセッションへ外から差し込む手段が無い以上、渡せるのは Claude が次に
-- ask_human を呼んだ瞬間だけなので、それまでここで待たせる。
CREATE TABLE inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  message_id  TEXT,              -- Discord のメッセージ。渡したときに印 (リアクション) を付け替える
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  taken_at    TEXT               -- NULL = まだ渡していない
);

CREATE INDEX inbox_pending_idx ON inbox (session_key, taken_at, id);
