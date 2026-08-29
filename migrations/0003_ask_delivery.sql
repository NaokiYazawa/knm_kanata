-- 「その問い (と答え) を Claude へ返せたか」の印。
--
-- 握っている SSE は **落ちることがある**。落ちると Claude 側に届くのは
-- `transport dropped mid-call; response for tool "ask_human" was lost` という **ask_id を
-- 含まない**エラーなので、`ask_wait` で拾い直せない。Claude にできるのは `ask_human` を
-- 呼び直すことだけで、それが素通りすると
--   ・Discord に同じ質問が 2 回出る
--   ・切れている間に人が答えていた場合、その答えが宙に浮いて永久に届かない
-- という 2 つの事故になる (実際に 2026-08-29 14:38 の質問が 1 つ失われた)。
--
-- この印があれば「返せていない問いが残っているなら、新しく作らずそれを拾い直す」と書ける。
ALTER TABLE asks ADD COLUMN delivered_at TEXT;

-- 既にある行は «もう会話が先へ進んだもの» なので、返せた扱いにする。
-- ここを NULL のままにすると、昔の答えを後から蘇らせてしまう。
UPDATE asks SET delivered_at = answered_at WHERE answer IS NOT NULL;

CREATE INDEX asks_undelivered_idx ON asks (session_key, delivered_at, created_at);
