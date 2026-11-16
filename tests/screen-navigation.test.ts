import { describe, expect, it, vi } from "vitest";
import { BOT_SCREENS, chatScreen, chatSelectionKey, libraryScreen, libraryTarget, rememberStartedChat, startedChat, claimAutomaticChat, retryAutomaticChat, resolveBotScreen, parentScreen, teamMapScreen, pinnedBotScreen } from "../client/screen-navigation";
import type { LibraryTarget } from "../client/navigation";

describe("mobile screen navigation", () => {
  it("keeps pending chat identity through layout rebuilds but separates hosts, bots and drafts", () => {
    const pending = chatSelectionKey("host-a", { botId: "bot-a", chatId: null }, "draft-a");
    expect(chatSelectionKey("host-a", { botId: "bot-a", chatId: null }, "draft-a")).toBe(pending);
    expect(chatSelectionKey("host-b", { botId: "bot-a", chatId: null }, "draft-a")).not.toBe(pending);
    expect(chatSelectionKey("host-a", { botId: "bot-b", chatId: null }, "draft-a")).not.toBe(pending);
    expect(chatSelectionKey("host-a", { botId: "bot-a", chatId: null }, "draft-b")).not.toBe(pending);
    expect(chatSelectionKey("host-a", { botId: "bot-a", chatId: "chat-a" }, "draft-a")).not.toBe(pending);
  });

  it("persists chat IDs and desktop settings panels without carrying a draft prompt forward", () => {
    const route = chatScreen({ botId: "bot-1", chatId: "chat-1" }, "Support", { open: true, section: "identity" });
    expect(route).toEqual({ screenId: "bot-chat", params: { botId: "bot-1", chatId: "chat-1", title: "Support", panel: "open", section: "identity" } });
    expect(chatScreen({ botId: "bot-1", chatId: "chat-2" }, "Support").params).toEqual({ botId: "bot-1", chatId: "chat-2", title: "Support" });
  });

  it("starts a setup route once across layout remounts and permits retry after failure", () => {
    const key = chatSelectionKey("auto-host", { botId: "auto-bot", chatId: null }, "auto-draft");
    expect(claimAutomaticChat(key)).toBe(true);
    expect(claimAutomaticChat(key)).toBe(false);
    expect(claimAutomaticChat(chatSelectionKey("auto-host", { botId: "auto-bot", chatId: null }, "another-draft"))).toBe(true);
    retryAutomaticChat(key);
    expect(claimAutomaticChat(key)).toBe(true);
    retryAutomaticChat(key);
  });

  it("gives explicit new chats distinct draft routes and preserves setup prompts", () => {
    const selection = { botId: "bot-1", chatId: null, prompt: "Help set up", title: "Setup" };
    const first = chatScreen(selection, "Support");
    const second = chatScreen(selection, "Support", { open: false, section: "identity" });
    expect(first.params).toMatchObject({ botId: "bot-1", title: "Support", prompt: "Help set up", chatTitle: "Setup" });
    expect(first.params?.draftId).toBeTruthy();
    expect(second.params?.draftId).not.toBe(first.params?.draftId);
    expect(second.params?.panel).toBeUndefined();
    expect(second.params?.section).toBeUndefined();
  });

  it("resumes the latest live chat from a pinned bot, independent of list order", () => {
    const bot = { id: "bot-1", name: "Support" };
    const chats = [
      { id: "old", updatedAt: "2026-11-01T10:00:00Z" },
      { id: "archived", updatedAt: "2026-11-16T12:00:00Z", archivedAt: "2026-11-16T12:00:00Z" },
      { id: "latest", updatedAt: "2026-11-16T11:00:00Z" },
      { id: "undated", updatedAt: "invalid" },
    ];
    expect(pinnedBotScreen(bot, null, chats)).toEqual({ screenId: "bot-chat", params: { botId: bot.id, title: bot.name, chatId: "latest" } });
    expect(pinnedBotScreen(bot, { screenId: "bot-settings", params: { botId: bot.id } }, chats)?.params?.chatId).toBe("latest");
  });

  it("preserves an active conversation or draft on repeated pinned-bot clicks", () => {
    const bot = { id: "bot-1", name: "Support" };
    const routes: Record<string, string>[] = [{ botId: bot.id, chatId: "active" }, { botId: bot.id, draftId: "draft" }];
    for (const params of routes) {
      expect(pinnedBotScreen(bot, { screenId: "bot-chat", params }, [{ id: "newer", updatedAt: "2026-11-16T12:00:00Z" }])).toBeNull();
    }
    const empty = pinnedBotScreen(bot, null, []);
    expect(empty?.params?.draftId).toBeTruthy();
    expect(empty?.params?.chatId).toBeUndefined();
    rememberStartedChat("host-a", empty?.params?.draftId, "first-chat");
    expect(startedChat("host-a", empty?.params?.draftId)).toBe("first-chat");
  });

  it("opens Bots for old and cold-restored Team map routes without needing route history", async () => {
    expect(resolveBotScreen("bot-teams", {})).toBe("bots");
    const opened = teamMapScreen();
    expect(resolveBotScreen("bot-teams", opened.params!)).toBe("bot-teams");
    vi.resetModules();
    const restarted = await import("../client/screen-navigation");
    expect(restarted.resolveBotScreen("bot-teams", opened.params!)).toBe("bots");
    expect(restarted.resolveBotScreen("bot-teams", restarted.teamMapScreen().params!)).toBe("bot-teams");
  });

  it("gives every detail screen an explicit parent independent of the host Back stack", () => {
    expect(parentScreen("bots", {})).toBeNull();
    for (const { id } of BOT_SCREENS.filter(({ id }) => id !== "bots")) {
      expect(parentScreen(id, { botId: "bot-1" })).not.toBeNull();
    }
    expect(parentScreen("bot-section", { botId: "bot-1" })?.target).toMatchObject({ screenId: "bot-settings", params: { botId: "bot-1" } });
    expect(parentScreen("bot-library-item", {})?.target.screenId).toBe("bot-library");
    // Other restored details remain accessible, with an explicit way home.
    expect(resolveBotScreen("bot-chat", { botId: "bot-1", chatId: "chat-1" })).toBe("bot-chat");
  });

  it("keeps library selections in Paseo route params so Back and remount restore the item", () => {
    const targets: LibraryTarget[] = [{ kind: "apps" }, { kind: "app", id: "gmail" }, { kind: "mcp", id: "server-1" }, { kind: "skill", id: "owner/repo/skill" }];
    for (const target of targets) {
      const route = libraryScreen(target);
      expect(route.screenId).toBe("bot-library-item");
      expect(libraryTarget(route.params!)).toEqual(target);
    }
    expect(libraryScreen(null)).toEqual({ screenId: "bot-library" });
    expect(libraryTarget({ kind: "mcp" })).toBeNull();
    expect(libraryTarget({ kind: "unknown", itemId: "x" })).toBeNull();
  });

  it("restores a chat created from a draft route when returning from settings, scoped to its host", () => {
    expect(startedChat("host-a", "draft-1")).toBeNull();
    rememberStartedChat("host-a", "draft-1", "chat-1");
    expect(startedChat("host-a", "draft-1")).toBe("chat-1");
    expect(startedChat("host-b", "draft-1")).toBeNull();
    expect(startedChat("host-a", "draft-2")).toBeNull();
    rememberStartedChat("host-a", undefined, "unrelated");
    expect(startedChat("host-a", undefined)).toBeNull();
  });
});
