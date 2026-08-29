-- そのセッションが「いまコンテキストをどれだけ使っているか」。
--
-- Claude Code には **コンテキスト量を外へ出す口が無い** (どの hook の入力にも入っていないし、
-- ステータスラインは対話 UI 専用でクラウドセッションでは動かない)。唯一の手掛かりは
-- 転写ログ (`transcript_path`) に残る `message.usage` なので、hook がそれを読んで送ってくる。
--
-- `updated_at` は触らない。あれは «握りが生きている» の印で、ここは «Claude が息をしている» の印。
-- 混ぜると、Stop hook が動いた (= ターンが終わった = もう握っていない) セッションを
-- 「まだ待っている」と誤判定して、死んだ質問へ回答を書き込むことになる。
ALTER TABLE sessions ADD COLUMN ctx_used_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN ctx_output_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN ctx_at TEXT;
