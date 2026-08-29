-- 実装計画の台帳。**本文は R2** にあり、ここにはどこに何があるかだけを置く。
--
-- ## なぜ D1 に置くのか
--
-- 計画の «同一性» を持つため。同じ計画を直して出し直すたびに URL が変わると、Discord の
-- スレッドに貼ったリンクが古い方を指し続ける。だから «どのスレッドの、何という名前か»
-- (scope, slug) から plan_id を引けるようにして、2 回目以降は同じ id へ上書きする。
--
-- ## plan_id を平文で置くことについて
--
-- `plan_id` は **そのまま公開 URL の鍵**になる (`/p/<plan_id>/`)。CLAUDE.md §3 の
-- «秘密を保存しない» は `PROJECTS_JSON` の fire トークン (Anthropic の API 資格情報で、
-- 漏れたときの爆風がアカウントの外へ出る) を指す規則で、こちらは «その 1 文書を開ける鍵»
-- でしかなく、**URL に載る以上 Workers のログにも残る**。
--
-- ハッシュだけ持つ形にすると上書きのたびに URL が変わり、上に書いた «リンクが変わらない»
-- を失う。取り消したいときは R2 のオブジェクトを消す (URL が 404 になる)。
CREATE TABLE plans (
  plan_id     TEXT PRIMARY KEY,   -- 32hex (128bit)。総当たりが成立しない長さを取る
  scope       TEXT NOT NULL,      -- thread:<id> | session:<key>
  slug        TEXT NOT NULL,      -- 計画の名前 (ディレクトリ名から作る)
  session_key TEXT NOT NULL,      -- 最後に置き直したセッション
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 同じ場所の同じ名前は 1 つ。ここが UNIQUE でないと «上書きのつもりが 2 本目» になる。
CREATE UNIQUE INDEX plans_scope_slug_idx ON plans (scope, slug);
