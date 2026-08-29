/**
 * 対象プロジェクトの定義。**D1 ではなく Worker の secret (`PROJECTS_JSON`) が正本**。
 *
 * routine の fire トークン (`sk-ant-oat01-…`) を持つため。秘密を DB に平文で寝かせないという
 * 一点だけの理由で、設定を DB に置く原則からここだけ外している。個人用で数件しかないので
 * secret 1 本に畳んで困らない。
 */

export type Project = Readonly<{
  /** Discord のコマンド選択肢に出る名前。 */
  name: string;
  /**
   * このプロジェクトの Discord チャンネル。**ここで叩いた `/claude` は自動でこの
   * プロジェクトになる** (スレッドの中で叩かれたら親チャンネルで照合する)。
   *
   * 1 チャンネルに 2 つのプロジェクトを結び付けない (どちらか決められない)。
   */
  channelId: string | null;
  /**
   * このプロジェクトが触れるリポジトリ。**表示用**で、正本は routine の `sources`。
   *
   * セッションが触れる範囲は `sources` が厳密な境界になっている (実測: 非公開リポジトリは
   * clone できず、`mcp__github__*` も sources にスコープされる)。ここに書いてあっても
   * routine に入っていなければ触れないので、**ここを増やしただけで増えたと思わない**。
   */
  repos: readonly string[];
  /** 表示用。Claude には routine 側の設定で渡るので、ここは案内に使うだけ。 */
  repoUrl: string;
  /** https://api.anthropic.com/v1/claude_code/routines/trig_…/fire */
  fireUrl: string;
  /** 当該 routine だけを起動できる per-routine トークン。 */
  fireToken: string;
}>;

export type ProjectsProblem = Readonly<{ message: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 秘密なので、失敗しても **値そのものは決してメッセージに載せない**。載せると管理者宛の
 * エラー表示やログにトークンが出る。
 */
export function parseProjects(raw: string | undefined): Project[] | ProjectsProblem {
  if (!raw) return { message: "PROJECTS_JSON が設定されていません" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { message: "PROJECTS_JSON が JSON として読めません" };
  }
  if (!Array.isArray(parsed)) return { message: "PROJECTS_JSON は配列である必要があります" };
  if (parsed.length === 0) return { message: "PROJECTS_JSON が空です" };

  const projects: Project[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (!isRecord(entry))
      return { message: `PROJECTS_JSON[${index}] がオブジェクトではありません` };
    const name = str(entry, "name");
    const repoUrl = str(entry, "repoUrl");
    const fireUrl = str(entry, "fireUrl");
    const fireToken = str(entry, "fireToken");
    if (!name || !repoUrl || !fireUrl || !fireToken) {
      return {
        message: `PROJECTS_JSON[${index}] に name / repoUrl / fireUrl / fireToken のどれかが足りません`,
      };
    }
    if (projects.some((p) => p.name === name)) {
      return { message: `PROJECTS_JSON に同じ name (${name}) が 2 つあります` };
    }

    const channelId = str(entry, "channelId");
    // 同じチャンネルに 2 つ結び付けると «そこで叩いた /claude» の行き先が決まらない。
    // 静かに片方を選ぶより、設定を読めないと言って止める方がよい。
    if (channelId && projects.some((p) => p.channelId === channelId)) {
      return { message: `PROJECTS_JSON に同じ channelId (${channelId}) が 2 つあります` };
    }

    const rawRepos = entry.repos;
    if (rawRepos !== undefined && !Array.isArray(rawRepos)) {
      return { message: `PROJECTS_JSON[${index}] の repos は配列である必要があります` };
    }
    const repos = (rawRepos ?? []).filter((v): v is string => typeof v === "string" && v !== "");

    projects.push({ name, channelId, repos, repoUrl, fireUrl, fireToken });
  }
  return projects;
}

export function isProjectsProblem(value: Project[] | ProjectsProblem): value is ProjectsProblem {
  return !Array.isArray(value);
}

export function findProject(projects: readonly Project[], name: string): Project | null {
  return projects.find((p) => p.name === name) ?? null;
}

/**
 * そのチャンネルに結び付いたプロジェクト。**`/claude` にプロジェクト名を書かせないための口**。
 *
 * スレッドの中で叩かれたら `channelId` はスレッドの id になるので、呼ぶ側が親チャンネルの
 * id を渡す (`channel.parent_id`)。ここは «どれか 1 つ» を返すだけで、親子の解決はしない。
 */
export function findProjectByChannel(
  projects: readonly Project[],
  channelIds: readonly (string | null | undefined)[],
): Project | null {
  for (const channelId of channelIds) {
    if (!channelId) continue;
    const hit = projects.find((p) => p.channelId === channelId);
    if (hit) return hit;
  }
  return null;
}
