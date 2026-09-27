<p align="center">
  <img src="https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

Personal bots for [Paseo](https://paseo.sh), like Grok Bot or Hermes Bots. Give each bot instructions, a model, memory, skills and tools, then chat with it in its own workspace or let it run routines.

## Features

| Area | Feature | What you get |
| --- | --- | --- |
| **Bots** | Bots with a job | Instructions, a provider and model, a host and an approval mode. Start blank or from a role such as Email triage or Researcher. |
| | Avatars | A pixel-art face, your own picture, or one OpenAI draws with your key. |
| | Voice | Read a reply aloud, or have the bot read each one as it finishes, in a voice of its own from the computer's voices. |
| | Presets and team files | Save a bot as a preset for new ones, set defaults for new bots, and share several bots in one file (Settings → Plugins → paseo-bots → Bots). |
| **Chats** | A workspace per bot | Every chat is a thread in that bot's workspace. |
| | Find and transcripts | Find words in a chat (⌘F), or copy it as a Markdown transcript. |
| | Approvals | Allow a command once, or always for that bot, exactly as it ran. Each bot's Overview lists what it won't do. |
| **Knowledge** | Memory | Each bot keeps a `MEMORY.md` it updates as it learns, and a daily log of its chats. Every change to its memory can be undone, and bots can search their past chats. |
| | Skills | One library of skills in Skills & Tools, switched on per bot. Skills imported from GitHub stay off until you review them. |
| | Learning | Send `/learn` after a task and the bot writes it up as a skill. Review it in the chat and save it. |
| | Playbooks | Step-by-step guidance a chat gets when its first message mentions the playbook's trigger words. |
| **Teamwork** | Teams | Put bots on a team with a Chief of Staff, who takes your requests and hands parts to the others. The Team map shows each team and what every bot is doing. |
| | Bots working together | A bot can ask another bot for help. The request starts a chat under that bot and the answer comes back; each bot asks you first, asks freely or never. |
| **Automation** | Routines | Run on a schedule, such as every weekday at 9:00 or any cron expression, or when a webhook is called. Bots can propose them from a chat, results can post back to a chat, and each routine keeps its run history and upcoming runs. |
| **Tools and apps** | MCP servers | MCP servers join the same library, switched on per bot. Import them from Claude Code, Claude Desktop or Cursor; they stay off until a test connects to them and lists their tools. |
| | Connected apps | 1,000+ apps such as Gmail, Slack and Notion through [Composio](https://composio.dev), with several named accounts per app. Keep a bot to an app's read-only or chosen tools, or to one of its accounts. A bot that needs another app asks with a sign-in card in the chat. |
| | Paseo tools | Bots can start other agents, open workspaces, set up schedules and use the browser. |

## Install

```bash
paseo plugin install npm:@oliexe/paseo-bots
```

Or paste `npm:@oliexe/paseo-bots` into **Settings → Plugins → Plugin source** in Paseo. Requires Paseo 0.9.2 or later.

## Connected apps

Connected apps run on your own Composio account.

1. Create a project at [platform.composio.dev](https://platform.composio.dev) and copy its API key (it starts with `ak_`).
2. In Paseo, open **Bots**, then **Skills & Tools** at the bottom of the bot list.
3. Next to **Connected apps**, press **+**, paste the key and press **Connect**.
4. Find an app, press **Connect** and finish signing in in your browser.
5. Switch the app on for a bot under the bot's **Access** settings, or on the app's page.

To add a second account of an app, such as a work and a personal Gmail, open the app's page and press **Connect** next to **Add another account**. Bots pick an account by its name.

When a bot needs an app that isn't connected, its chat shows a card: press **Sign in**, finish on Composio's page, then **Continue**. Signing in from the card also switches the app on for that bot.

To limit what a bot does with an app, open the app under the bot's **Access** settings: allow all of its tools, only the read-only ones, or the ones you choose, and keep the bot to one account. The relay refuses anything else, and turns off Composio's remote workbench for bots with limits, since code there could run any app's tools.

The key stays on the Paseo host and never reaches the agents: bots reach Composio through a local relay that only lets each bot use the apps you switched on for it.

## Screenshots

| Bots | Bot settings |
| --- | --- |
| ![Bots](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/splash.png) | ![Bot settings](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bot.png) |
| **Skills** | **MCP servers** |
| ![Skills](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/skills.png) | ![MCP servers](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/mcp.png) |
| **Connected apps** | **Teams** |
| ![Connected apps](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/apps.png) | ![Teams](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/teams.png) |
