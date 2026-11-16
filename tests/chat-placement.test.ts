import { describe, expect, it, vi } from "vitest";
import { startBotChat, type ChatApi } from "../shared/chat";
import { EMPTY_LIBRARY } from "../shared/bot";
import { makeBot } from "./helpers";

function fixture(background: boolean) {
  const snapshot = { projectId: "project", projectRootPath: "/bots", workspaceDirectory: "/bots/inbox", title: "Inbox", background };
  const handle = {
    current: () => snapshot,
    refresh: async () => snapshot,
    setTitle: vi.fn(),
    archive: vi.fn(),
    agents: { create: vi.fn(async () => ({ id: "chat" })) },
  };
  const api = {
    projects: { list: async () => ({ projects: [snapshot] }) },
    workspaces: { list: vi.fn(async () => ({ entries: [snapshot] })), ref: vi.fn(() => handle), open: vi.fn(async () => handle), create: vi.fn(async () => handle) },
    providers: { snapshot: async () => ({ entries: [] }) },
  } satisfies ChatApi;
  const start = () => startBotChat(api, { bot: makeBot({ model: "model" }), library: EMPTY_LIBRARY, placement: { path: "/bots/inbox", projectRoot: "/bots" }, prompt: "Hello", systemPrompt: "Help" });
  return { api, start };
}

describe("bot chat placement", () => {
  it("creates a background workspace instead of reusing an older visible workspace", async () => {
    const { api, start } = fixture(false);
    expect(await start()).toBe("chat");
    expect(api.workspaces.create).toHaveBeenCalledWith({ title: "Inbox", background: true, source: { kind: "directory", path: "/bots/inbox", projectId: "project" } });
    expect(api.workspaces.ref).not.toHaveBeenCalled();
  });

  it("discovers and reuses the bot's background workspace", async () => {
    const { api, start } = fixture(true);
    await start();
    expect(api.workspaces.list).toHaveBeenCalledWith({ filter: { includeBackground: true } });
    expect(api.workspaces.ref).toHaveBeenCalled();
    expect(api.workspaces.create).not.toHaveBeenCalled();
  });
});
