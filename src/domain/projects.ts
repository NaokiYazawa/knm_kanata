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
    projects.push({ name, repoUrl, fireUrl, fireToken });
  }
  return projects;
}

export function isProjectsProblem(value: Project[] | ProjectsProblem): value is ProjectsProblem {
  return !Array.isArray(value);
}

export function findProject(projects: readonly Project[], name: string): Project | null {
  return projects.find((p) => p.name === name) ?? null;
}
