<p align="center">
  <img src="https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

Personal bots for [Paseo](https://paseo.sh), like Grok Bot or Hermes Bots. Give each bot instructions, a model, skills and MCP tools, then chat with it in its own workspace.

## Features

- **Bots with a job**: instructions, provider and model, host, approval mode and a pixel-art avatar. Start blank or from a role such as Email triage or Researcher.
- **Presets and team files**: save a bot as a preset for new ones, set defaults for new bots, and share several bots in one file (Settings → Plugins → paseo-bots → Bots).
- **A workspace per bot**: every chat is a thread in that bot's workspace.
- **Approvals**: allow a command once or always for a bot, exactly as it ran. Each bot's Overview lists what it won't do.
- **Memory**: each bot keeps a `MEMORY.md` it updates as it learns, and a daily log of its chats. Every change to its memory can be undone, and bots can search their past chats.
- **Routines**: runs on a schedule, such as every weekday at 9:00 or any cron expression, or when its webhook is called. Bots can propose them from a chat, results can post back to a chat, and each routine keeps its run history and upcoming runs.
- **Teams**: put bots on a team with a Chief of Staff, who takes your requests and hands parts to the others. The Team map shows each team and what every bot is doing.
- **Bots working together**: a bot can ask another bot for help. The request starts a chat under that bot and the answer comes back; each bot asks you first, asks freely or never.
- **Skills & Tools**: one library of skills and MCP servers, switched on per bot. Import skills from GitHub (they stay off until you review them) and test servers to see their tools.
- **Playbooks**: step-by-step guidance a chat gets when its first message mentions the playbook's trigger words.
- **Learning**: send `/learn` after a task and the bot writes it up as a skill. Review it in the chat and save it.
- **Connected apps**: 1,000+ apps such as Gmail, Slack and Notion through [Composio](https://composio.dev), with several named accounts per app, such as work and personal.
- **Paseo tools**: bots can start other agents, open workspaces, set up schedules and use the browser.

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

The key stays on the Paseo host and never reaches the agents: bots reach Composio through a local relay that only lets each bot use the apps you switched on for it.

## Screenshots

| Bots | Bot settings |
| --- | --- |
| ![Bots](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/splash.png) | ![Bot settings](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bot.png) |
| **Skills** | **MCP servers** |
| ![Skills](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/skills.png) | ![MCP servers](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/mcp.png) |
| **Connected apps** | |
| ![Connected apps](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/apps.png) | |
