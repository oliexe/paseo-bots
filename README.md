<p align="center">
  <img src="https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

Personal bots for [Paseo](https://paseo.sh), like Grok Bot or Hermes Bots. Give each bot instructions, a model, skills and MCP tools, then chat with it in its own workspace.

## Features

- **Bots with a job**: instructions, provider and model, host, approval mode and a pixel-art avatar. Start blank or from a role such as Email triage or Researcher.
- **A workspace per bot**: every chat is a thread in that bot's workspace.
- **Memory**: each bot keeps a `MEMORY.md` it updates as it learns, and a daily log of its chats. Every change to its memory can be undone, and bots can search their past chats.
- **Routines**: runs on a schedule, such as every weekday at 9:00 or any cron expression.
- **Skills & Tools**: one library of skills and MCP servers, switched on per bot. Import skills from GitHub (they stay off until you review them) and test servers to see their tools.
- **Learning**: send `/learn` after a task and the bot writes it up as a skill. Review it in the chat and save it.
- **Connected apps**: 1,000+ apps such as Gmail, Slack and Notion through [Composio](https://composio.dev).
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

The key stays on the Paseo host and never reaches the agents: bots reach Composio through a local relay that only lets each bot use the apps you switched on for it.

## Screenshots

| Bots | Bot settings |
| --- | --- |
| ![Bots](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/splash.png) | ![Bot settings](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bot.png) |
| **Skills** | **MCP servers** |
| ![Skills](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/skills.png) | ![MCP servers](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/mcp.png) |
| **Connected apps** | |
| ![Connected apps](https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/apps.png) | |
