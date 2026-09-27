<p align="center">
  <img src="https://raw.githubusercontent.com/oliexe/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

Personal bots for [Paseo](https://paseo.sh), like Grok Bot or Hermes Bots. Give each bot instructions, a model, memory, skills and tools, then chat with it in its own workspace or let it run routines.

## Features

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
