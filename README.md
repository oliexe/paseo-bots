<p align="center">
  <img src="https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

Personal bots for [Paseo](https://paseo.sh), like Grok Bot or Hermes Bots. Give each bot instructions, a model, memory, skills and tools, then chat with it in its own workspace or let it run routines.

## Core Features

| Feature | Description |
| --- | --- |
| **Bots** | Instructions, provider and model, host, approval mode and an avatar. Start blank or from a role such as Email triage or Researcher. |
| **Memory** | Each bot keeps a `MEMORY.md` it updates as it learns, and a daily log of its chats. |
| **Routines** | Runs on a schedule, such as every weekday at 9:00, or when its webhook is called. |
| **Teams** | Put bots on a team with a Chief of Staff, who takes your requests and hands parts to the others. |
| **Skills & Tools** | One library of skills and MCP servers, switched on per bot. Import skills from GitHub and MCP servers from Claude Code, Claude Desktop or Cursor. |
| **Learning** | Send `/learn` after a task and the bot writes it up as a skill. |
| **Connected apps** | 1,000+ apps such as Gmail, Slack and Notion through [Composio](https://composio.dev), with several named accounts per app. |
| **Paseo tools** | Bots can start other agents, open workspaces, set up schedules and use the browser. |

## Screenshots

| | |
| --- | --- |
| **Bots** | **Bot settings** |
| ![Bots](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/splash.png) | ![Bot settings](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bot.png) |
| **Skills** | **MCP servers** |
| ![Skills](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/skills.png) | ![MCP servers](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/mcp.png) |
| **Connected apps** | **Teams** |
| ![Connected apps](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/apps.png) | ![Teams](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/teams.png) |

## Install

```bash
paseo plugin install npm:@oliexe/paseo-bots
```

Or paste `npm:@oliexe/paseo-bots` into **Settings → Plugins → Plugin source** in Paseo. Requires Paseo 0.9.2 or later.

## Usage

### Bots

1. Open **Bots** in Paseo's sidebar and press **New bot**. Start blank, from a role, from one of your presets, or paste a bot or team file under **Import**.
2. Chat with it. Every chat is a thread in the bot's workspace; **Open in Paseo** in a chat's menu shows it in Paseo's own view.
3. Open its settings with the panel button at the top right of a chat, or **Open bot settings** in the bot's menu. **Identity** holds the name, avatar and voice, **Soul** its standing instructions, **Model** the provider and model, and **Permissions** the approval mode.

### Memory

A bot updates its `MEMORY.md` when it learns something worth keeping, for example when you say "Remember that I prefer short answers". New chats start with it.

In the bot's settings, **Memory** shows `MEMORY.md` and its topic files, which you can edit, a **Daily log** of its chats, and **Changes**, where **Undo** puts a file back the way it was.

### Routines

1. In the bot's settings, open **Routines** and press **New routine**.
2. Give it a name and a prompt. The prompt is the first message of each run.
3. Pick when it repeats: a preset such as **Weekdays 9:00** or your own cron expression, **Once**, or **When its webhook is called**.
4. To collect results in one place, pick a chat under **Post results to**. Each run still gets its own chat.

Bots can propose routines too: ask in a chat, then press **Create routine** on the card. A webhook routine's URL is under **Copy webhook URL** in its menu; `POST` to it from this computer.

### Teams

1. Press **Team map** at the bottom of the bot list, then **New team**.
2. Name the team, switch on its members, pick a **Lead** as its Chief of Staff, and add shared instructions for every member.
3. Send your requests to the Chief of Staff. It hands parts of the work to its teammates.

Whether a bot may ask others for help is set in its settings under **Permissions → Contact other bots**: **Ask first**, **Allowed** or **Off**.

### Skills & Tools

Press **Skills & Tools** at the bottom of the bot list.

- **Skills**: press **+** to import skills from GitHub (`owner/repo`, a folder or a `SKILL.md` link) or write a new one. Open an imported skill and press **Review** to turn it on.
- **MCP servers**: press **+**, then **New server**, or **Import config** to pick up the servers set up in Claude Code, Claude Desktop or Cursor. Press **Test and turn on** on the server's page.

Then give them to a bot in its settings: skills under **Skills**, MCP servers under **Access**.

### Learning

After a task, send `/learn` in the chat, or `/learn <what to focus on>`. The bot writes up what worked as a skill and shows it as a card; press **Save skill** to add it to Skills & Tools and turn it on for that bot.

### Connected apps

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

### Paseo tools

Bots get Paseo's own tools, so you can ask one in a chat to start other agents, open workspaces and terminals, set up schedules or use the browser. A bot's **Access** settings show whether they're on, and **Turn on** there switches them on for every agent on the host.
