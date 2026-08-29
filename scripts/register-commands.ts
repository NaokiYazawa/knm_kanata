/**
 * Discord のスラッシュコマンドを登録する。`node scripts/register-commands.ts`。
 *
 * グローバル登録なので反映まで数分かかることがある。すぐ試したいときは
 * `DISCORD_GUILD_ID` を入れてギルド限定で登録する (即時反映)。
 *
 * 必要な環境変数 (.env.local に置く):
 *   DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN / PROJECTS_JSON / (任意) DISCORD_GUILD_ID
 */

export {};

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error("DISCORD_APPLICATION_ID と DISCORD_BOT_TOKEN が要ります");
  process.exit(1);
}

type ProjectEntry = { name?: unknown };

function projectChoices(): { name: string; value: string }[] {
  const raw = process.env.PROJECTS_JSON;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: ProjectEntry) => (typeof entry.name === "string" ? entry.name : null))
      .filter((name): name is string => name !== null)
      .slice(0, 25)
      .map((name) => ({ name, value: name }));
  } catch {
    return [];
  }
}

const choices = projectChoices();

const commands = [
  {
    name: "claude",
    description: "クラウドの Claude Code に指示を投げる",
    options: [
      {
        type: 3,
        name: "task",
        description: "やってほしいこと",
        required: true,
        max_length: 4000,
      },
      {
        type: 3,
        name: "project",
        description: "対象プロジェクト (1 つしか無いときは省略可)",
        required: false,
        ...(choices.length > 0 ? { choices } : {}),
      },
    ],
  },
];

const url = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`登録に失敗しました: ${response.status}`);
  console.error(await response.text());
  process.exit(1);
}

console.log(
  `登録しました (${guildId ? `guild ${guildId}` : "global"}) / project の選択肢 ${choices.length} 件`,
);
