import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent } from "@getpaseo/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, type LayoutRectangle, Platform, Text, View } from "react-native";
import { randomSeed } from "../shared/avatar";
import { DEFAULT_BOT_LIST_UI, EMPTY_LIBRARY, newBotId, pushHistory, type Bot, type BotListUi, type BotMcpServer, type Library } from "../shared/bot";
import { addMcpServers, upsertSkills } from "../shared/library";
import { startBotChat, syncBotWorkspaceTitle } from "../shared/chat";
import { moveKey } from "../shared/sidebar";
import { appsMountRpc, ensureBotHomeRpc, exportBotRpc, importBotRpc, systemPromptRpc } from "../shared/rpc";
import type { BotTemplate } from "../shared/templates";
import { AvatarTheme } from "./Avatar";
import { botMenuEntries, chatMenuEntries, ExportDialog, NewBotDialog, RenameDialog } from "./BotDialogs";
import { BotSidebar, type ChatMenuContext, type MenuSource, type Selection } from "./BotSidebar";
import { ChatPane, type OutgoingMessage } from "./ChatPane";
import { useBotHost, useChatInvalidation, useHostResolver, useProviders, type LocalHost } from "./data";
import { takeIntent } from "./intent";
import { LibraryView } from "./library/LibraryView";
import { onLibraryTarget, type LibraryTarget } from "./navigation";
import { Splash } from "./Splash";
import { ResizeHandle, SlideOver } from "./ui/Columns";
import { fitColumns } from "../shared/layout";
import { confirmDialog, errorText, nativeTokens } from "./native";
import { measureAnchor, MenuProvider, useMenu } from "./ui/Menu";
import { useKeyboardHeight } from "./keyboard";
import { newMessageId } from "./sent-attachments";
import { BotPanel, type SectionId } from "./panel/BotPanel";
import { useBotSettings } from "./useBotSettings";
import { useChat } from "./useChat";
import { ui, useTypeScale } from "./typography";

type Colors = PluginTheme["colors"];

const SETUP_PROMPT =
  "Let's set you up. Interview me one short question at a time about what I want from you, how I like to work, and what you should never do. " +
  "Then propose standing instructions for yourself and a starting MEMORY.md. Write the memory file once I confirm, and give me the instructions to paste into your Soul settings.";

/** Autosave delay after the last edit in the settings panel. */
const SAVE_DELAY_MS = 600;

function blankBot(provider: string, template?: BotTemplate): Bot {
  const now = new Date().toISOString();
  return {
    id: newBotId(),
    name: template?.name ?? "New bot",
    title: template?.title ?? "",
    description: template?.description ?? "",
    avatar: { seed: template?.avatarSeed ?? randomSeed(), palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: template?.soul ?? "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    routines: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function BotsSurface(props: PluginSurfaceProps) {
  const { colors } = props.theme;
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <BotsSurfaceContent {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}


function BotsSurfaceContent({ theme, layout, host, navigation }: PluginSurfaceProps) {
  const { colors } = theme;
  const { settings, latest, commit } = useBotSettings();
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const localHost: LocalHost = { id: host.id, label: host.label };
  const localProviders = useProviders(useBotHost(null, localHost));
  const resolveHost = useHostResolver(localHost);
  const exportBot = useRpc(exportBotRpc);
  const importBot = useRpc(importBotRpc);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; section: SectionId | null }>({ open: false, section: null });
  const [panelVersion, setPanelVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  /** Skills & Tools replaces the bot list and chat while open; `target` is its page (null: the list, on compact). */
  const [libraryView, setLibraryView] = useState<{ target: LibraryTarget | null } | null>(null);
  const [renaming, setRenaming] = useState<Bot | null>(null);
  const [exporting, setExporting] = useState<Bot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Bot>>({});
  // List state (collapsed groups, pins, order, display options) applies at once and saves behind.
  const [uiOverride, setUiOverride] = useState<BotListUi | null>(null);
  const uiRef = useRef<BotListUi | null>(null);
  const paneRef = useRef<View>(null);
  const keyboardHeight = useKeyboardHeight();
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  /** Widths while a resize handle is being dragged; saved to the list UI on release. */
  const [dragWidths, setDragWidths] = useState<{ list?: number; panel?: number }>({});
  // Re-renders the whole surface when Paseo's interface/content/code sizes change.
  const typeVersion = useTypeScale();
  useChatInvalidation();

  // ------------------------------------------------------------ persistence
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = draftsRef.current;
    if (Object.keys(pending).length === 0) return;
    const ok = await commit((values) => {
      let history = values.history;
      const bots = values.bots.map((bot) => {
        const draft = pending[bot.id];
        if (!draft) return bot;
        history = pushHistory(history, bot);
        return draft;
      });
      return { ...values, bots, history };
    });
    if (ok) {
      setDrafts((current) => {
        const next = { ...current };
        for (const [id, bot] of Object.entries(pending)) if (next[id] === bot) delete next[id];
        return next;
      });
    }
  };

  const patchBot = (botId: string, patch: Partial<Bot>) => {
    setDrafts((current) => {
      const base = current[botId] ?? (latest.current.status === "ready" ? latest.current.values.bots.find((bot) => bot.id === botId) : undefined);
      return base ? { ...current, [botId]: { ...base, ...patch, updatedAt: new Date().toISOString() } } : current;
    });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  // Save pending edits when the surface closes.
  useEffect(() => () => void flush(), []);

  const currentUi = (): BotListUi =>
    uiRef.current ?? (latest.current.status === "ready" ? latest.current.values.ui : undefined) ?? DEFAULT_BOT_LIST_UI;

  const updateUi = (mutate: (current: BotListUi) => BotListUi) => {
    const next = mutate(currentUi());
    uiRef.current = next;
    setUiOverride(next);
    void commit((values) => ({ ...values, ui: uiRef.current ?? next }));
  };

  /** Applies a patch to the saved bot and to any unsaved draft of it, so autosave can't undo it. */
  const updateBot = (botId: string, patch: Partial<Bot>, recordHistory = false) => {
    setDrafts((current) => (current[botId] ? { ...current, [botId]: { ...current[botId], ...patch } } : current));
    return commit((values) => {
      const previous = values.bots.find((entry) => entry.id === botId);
      if (!previous) return values;
      return {
        ...values,
        bots: values.bots.map((entry) => (entry.id === botId ? { ...entry, ...patch, updatedAt: new Date().toISOString() } : entry)),
        history: recordHistory ? pushHistory(values.history, previous) : values.history,
      };
    });
  };

  /** Opens Skills & Tools. Unsaved bot edits are saved first so the library sees them. */
  const enterLibrary = (target: LibraryTarget | null) => {
    void flush();
    setLibraryView({ target });
  };

  // A bot's settings and the bot list ask for Skills & Tools through the navigation store.
  const enterLibraryRef = useRef(enterLibrary);
  enterLibraryRef.current = enterLibrary;
  useEffect(
    () =>
      onLibraryTarget((target) => {
        enterLibraryRef.current(target);
      }),
    [],
  );

  // Android's Back steps out of Skills & Tools, closes the settings panel, then goes from a
  // chat back to the list, before it would leave the plugin (Paseo's workspace screen does
  // the same for its explorer).
  const backState = useRef({ panelOpen: panel.open, section: panel.section, compact: layout.compact, hasSelection: selection !== null, libraryView });
  backState.current = { panelOpen: panel.open, section: panel.section, compact: layout.compact, hasSelection: selection !== null, libraryView };
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      const state = backState.current;
      if (state.libraryView) {
        setLibraryView(state.compact && state.libraryView.target ? { target: null } : null);
        return true;
      }
      if (state.panelOpen) {
        setPanel({ open: false, section: state.section });
        return true;
      }
      if (state.compact && state.hasSelection) {
        setSelection(null);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, []);

  // "New bot" from the Command Center opens a fresh Bots screen; only that one consumes it.
  useEffect(() => {
    const intent = takeIntent();
    if (intent?.kind === "new-bot") setCreating(true);
  }, []);

  if (settings.status !== "ready") {
    return (
      <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: colors.surface0, justifyContent: settings.status === "loading" ? "center" : "flex-start", alignItems: settings.status === "loading" ? "center" : "stretch" }}>
        {settings.status === "loading" ? (
          <ActivityIndicator size="large" color={colors.foregroundMuted} accessibilityLabel="Loading bots" />
        ) : (
          <Text style={{ fontSize: ui(14), color: colors.statusDanger }}>Couldn't read bots: {settings.error}</Text>
        )}
        {settings.status === "invalid" ? (
          <SettingsCard>
            <SettingsAction label="Reset bots" hint="Replaces the unreadable bot list with an empty one." actionLabel="Reset" onPress={() => void settings.reset()} />
          </SettingsCard>
        ) : null}
      </View>
    );
  }

  const listUi = uiOverride ?? settings.values.ui ?? DEFAULT_BOT_LIST_UI;
  const columns = fitColumns(
    surfaceWidth || 1600,
    dragWidths.list ?? listUi.listWidth,
    panel.open && selection ? (dragWidths.panel ?? listUi.panelWidth) : null,
  );
  const commitWidth = (key: "listWidth" | "panelWidth", width: number) => {
    setDragWidths({});
    updateUi((current) => ({ ...current, [key]: Math.round(width) }));
  };
  const allBots = settings.values.bots.map((bot) => drafts[bot.id] ?? bot);
  const library = settings.values.library ?? EMPTY_LIBRARY;
  const listed = allBots
    .filter((bot) => listUi.showArchived || !bot.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const selectedBot = selection ? allBots.find((bot) => bot.id === selection.botId) : undefined;
  const archivedCount = allBots.filter((bot) => bot.archived).length;

  // ------------------------------------------------------------ actions

  const select = (next: Selection) => {
    setSelection(next);
    if (currentUi().collapsed.includes(next.botId)) {
      updateUi((current) => ({ ...current, collapsed: current.collapsed.filter((id) => id !== next.botId) }));
    }
  };

  const openPanel = (bot: Bot, section: SectionId | null) => {
    if (selection?.botId !== bot.id) select({ botId: bot.id, chatId: null });
    setPanel({ open: true, section });
  };

  /**
   * Saves a new bot. MCP servers from a template or an imported file join the
   * library (reusing a server of the same name) and are switched on for the bot;
   * imported skills join it unless the library already has them.
   */
  const addBot = async (bot: Bot, section: SectionId = "identity", extras: { mcpServers?: BotMcpServer[]; skills?: { id: string; description: string; source: string }[] } = {}) => {
    const saved = await commit((values) => {
      let library = values.library ?? EMPTY_LIBRARY;
      const known = new Set(library.skills.map((skill) => skill.id));
      library = upsertSkills(library, (extras.skills ?? []).filter((skill) => !known.has(skill.id)));
      const added = addMcpServers(library, extras.mcpServers ?? [], { reuseByName: true });
      const withServers = { ...bot, mcpServerIds: [...new Set([...bot.mcpServerIds, ...added.ids])] };
      return { ...values, bots: [...values.bots, withServers], library: added.library };
    });
    if (saved) {
      select({ botId: bot.id, chatId: null });
      setPanel({ open: true, section });
    }
  };

  const defaultProvider = () => {
    const ready = (localProviders.data ?? []).filter((entry) => entry.status === "ready");
    return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
  };

  const duplicate = async (bot: Bot) => {
    await flush();
    const { json } = await exportBot({ bot, includeMemory: false });
    const { bot: copy } = await importBot({ botId: newBotId(), json });
    // Same library items as the original; the copy's own file only carries redacted server settings.
    await addBot({
      ...copy,
      name: `${bot.name} copy`,
      hostId: bot.hostId,
      cwd: bot.cwd,
      alwaysAllow: bot.alwaysAllow,
      skillIds: bot.skillIds,
      mcpServerIds: bot.mcpServerIds,
      avatar: { ...bot.avatar, seed: randomSeed() },
    });
  };

  const remove = async (bot: Bot) => {
    const ok = await commit((values) => ({
      ...values,
      bots: values.bots.filter((entry) => entry.id !== bot.id),
      history: values.history.filter((entry) => entry.botId !== bot.id),
    }));
    if (!ok) return;
    if (selection?.botId === bot.id) setSelection(null);
    updateUi((current) => {
      const { [bot.id]: _order, ...chatOrder } = current.chatOrder;
      return {
        ...current,
        collapsed: current.collapsed.filter((id) => id !== bot.id),
        pinnedChats: current.pinnedChats.filter((pin) => pin.botId !== bot.id),
        chatOrder,
      };
    });
  };

  /** Swaps a bot with its neighbour in the list (pinned and unpinned bots stay in their own runs). */
  const moveBot = (bot: Bot, delta: -1 | 1): (() => void) | undefined => {
    const index = listed.findIndex((entry) => entry.id === bot.id);
    const neighbour = listed[index + delta];
    if (index === -1 || !neighbour || neighbour.pinned !== bot.pinned) return undefined;
    return () =>
      void commit((values) => {
        const bots = [...values.bots];
        const a = bots.findIndex((entry) => entry.id === bot.id);
        const b = bots.findIndex((entry) => entry.id === neighbour.id);
        if (a === -1 || b === -1) return values;
        [bots[a], bots[b]] = [bots[b]!, bots[a]!];
        return { ...values, bots };
      });
  };

  const copy = (text: string, done: string) =>
    void copyText(text)
      .then(() => toast.show(done, { variant: "success" }))
      .catch(() => toast.error("Unable to copy"));

  const openBotMenu = (bot: Bot, anchor: LayoutRectangle, source: MenuSource) => {
    const botHost = resolveHost(bot.hostId);
    const chats = queryClient.getQueryData<PaseoAgent[]>(["paseo-bot", "chats", botHost.key, bot.id]) ?? [];
    const workspaceId = chats.find((chat) => chat.workspaceId)?.workspaceId;
    const openWorkspace = navigation?.openWorkspace;
    menu.open({
      anchor,
      align: source === "kebab" ? "end" : "start",
      width: 220,
      title: "Bot actions",
      entries: botMenuEntries({
        bot,
        onOpenInPaseo: openWorkspace && workspaceId && botHost.online ? () => openWorkspace({ workspaceId, serverId: botHost.key }) : undefined,
        onOpenSettings: () => openPanel(bot, "identity"),
        onTogglePin: () => void updateBot(bot.id, { pinned: !bot.pinned }),
        onMoveUp: moveBot(bot, -1),
        onMoveDown: moveBot(bot, 1),
        onRename: () => setRenaming(bot),
        onDuplicate: () => duplicate(bot).catch((error: unknown) => toast.error(`Couldn't duplicate: ${errorText(error)}`)),
        onExport: () => setExporting(bot),
        onCopyId: () => copy(bot.id, "Bot ID copied"),
        onToggleArchive: () => void updateBot(bot.id, { archived: !bot.archived }),
        onDelete: async () => {
          const confirmed = await confirmDialog({
            title: "Delete bot?",
            message: `Delete "${bot.name}"?\n\nIts chats stay on the host and remain in Paseo's history.`,
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
            destructive: true,
          });
          if (confirmed) await remove(bot);
        },
      }),
    });
  };

  const openChatMenu = (bot: Bot, chat: PaseoAgent, anchor: LayoutRectangle, source: MenuSource, context: ChatMenuContext) => {
    const botHost = resolveHost(bot.hostId);
    const move = (delta: -1 | 1) => {
      const order = moveKey(context.siblings, chat.id, delta);
      return order ? () => updateUi((current) => ({ ...current, chatOrder: { ...current.chatOrder, [bot.id]: order } })) : undefined;
    };
    const unpin = (current: BotListUi) => ({ ...current, pinnedChats: current.pinnedChats.filter((pin) => pin.chatId !== chat.id) });
    const openAgent = navigation?.openAgent;
    menu.open({
      anchor,
      align: source === "kebab" ? "end" : "start",
      width: 260,
      title: "Chat actions",
      entries: chatMenuEntries({
        pinned: context.pinned,
        onCopyPath: () => (chat.cwd ? copy(chat.cwd, "Path copied") : toast.error("Chat path not available")),
        onCopyId: () => copy(chat.id, "Chat ID copied"),
        onTogglePin: () =>
          updateUi((current) =>
            context.pinned ? unpin(current) : { ...current, pinnedChats: [...current.pinnedChats, { botId: bot.id, chatId: chat.id }] },
          ),
        move: context.pinned || listUi.chatSort !== "manual" ? null : { up: move(-1), down: move(1) },
        onOpenInPaseo: openAgent && botHost.online ? () => openAgent({ agentId: chat.id, serverId: botHost.key }) : undefined,
        onArchive: async () => {
          if (!botHost.api) {
            toast.error("Host is not connected");
            return;
          }
          try {
            await botHost.api.agents.ref(chat.id).archive();
            if (selection?.chatId === chat.id) setSelection({ botId: bot.id, chatId: null });
            if (context.pinned) updateUi(unpin);
            await queryClient.invalidateQueries({ queryKey: ["paseo-bot", "chats", botHost.key, bot.id] });
          } catch (error) {
            toast.error(`Failed to archive chat: ${errorText(error)}`);
          }
        },
      }),
    });
  };

  const openDisplayMenu = (anchor: LayoutRectangle) => {
    menu.open({
      anchor,
      align: "end",
      width: 232,
      title: "Display",
      entries: [
        {
          label: "Archived bots",
          trailing: listUi.showArchived ? "Shown" : archivedCount ? `Hidden (${archivedCount})` : "Hidden",
          onSelect: () => updateUi((current) => ({ ...current, showArchived: !current.showArchived })),
        },
        {
          label: "Chat order",
          trailing: listUi.chatSort === "manual" ? "Manual" : "Last activity",
          onSelect: () => updateUi((current) => ({ ...current, chatSort: current.chatSort === "manual" ? "activity" : "manual" })),
        },
      ],
    });
  };

  /** The chat header's bot menu has no anchor of its own; hang it from the pane's top-right corner. */
  const openBotMenuFromPane = (bot: Bot) =>
    void measureAnchor(paneRef).then((rect) =>
      openBotMenu(bot, rect ? { x: rect.x + rect.width - 44, y: rect.y, width: 36, height: 36 } : { x: 0, y: 0, width: 0, height: 0 }, "kebab"),
    );

  const sidebar = (
    <BotSidebar
      colors={colors}
      bots={listed}
      hiddenArchivedCount={listUi.showArchived ? 0 : archivedCount}
      selection={selection}
      ui={listUi}
      localHost={localHost}
      touch={layout.compact || layout.platform !== "web"}
      splash={layout.compact}
      onToggle={(botId) =>
        updateUi((current) => ({
          ...current,
          collapsed: current.collapsed.includes(botId) ? current.collapsed.filter((id) => id !== botId) : [...current.collapsed, botId],
        }))
      }
      onTogglePinnedSection={() => updateUi((current) => ({ ...current, pinnedCollapsed: !current.pinnedCollapsed }))}
      onShowArchived={() => updateUi((current) => ({ ...current, showArchived: true }))}
      onSelect={select}
      onNewBot={() => setCreating(true)}
      onBotMenu={openBotMenu}
      onChatMenu={openChatMenu}
      onDisplayMenu={openDisplayMenu}
    />
  );

  const pane =
    selectedBot && selection ? (
      <SelectedChat
        key={`${selectedBot.id}:${selection.chatId ?? "new"}`}
        colors={colors}
        bot={selectedBot}
        library={library}
        selection={selection}
        localHost={localHost}
        panelOpen={panel.open}
        layout={layout}
        keyboardOpen={keyboardHeight > 0}
        typeVersion={typeVersion}
        onBack={layout.compact ? () => setSelection(null) : undefined}
        onBotMenu={(anchor) => (anchor ? openBotMenu(selectedBot, anchor, "kebab") : openBotMenuFromPane(selectedBot))}
        onTogglePanel={() => setPanel({ open: !panel.open, section: panel.section })}
        onStarted={(chatId) => setSelection({ botId: selectedBot.id, chatId })}
      />
    ) : (
      <Splash colors={colors} />
    );

  const settingsPanel =
    selectedBot && panel.open ? (
      <BotPanel
        key={`${selectedBot.id}:${panelVersion}`}
        colors={colors}
        compact={layout.compact}
        bot={selectedBot}
        localHost={localHost}
        history={settings.values.history}
        library={library}
        section={panel.section}
        onSection={(section) => setPanel({ open: true, section })}
        onClose={() => setPanel({ open: false, section: panel.section })}
        onPatch={(patch) => patchBot(selectedBot.id, patch)}
        flush={flush}
        onRestore={(snapshot) => {
          patchBot(selectedBot.id, snapshot);
          setPanelVersion((version) => version + 1);
          toast.show("Restored. Undo it from History if needed.", { variant: "success" });
        }}
        onSetup={() => select({ botId: selectedBot.id, chatId: null, prompt: SETUP_PROMPT })}
      />
    ) : null;

  if (libraryView) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}>
        <LibraryView
          colors={colors}
          layout={layout}
          values={settings.values}
          commit={commit}
          target={libraryView.target}
          onTarget={(target) => setLibraryView({ target })}
          onBack={() => setLibraryView(null)}
        />
      </View>
    );
  }

  return (
    <>
    {/* The host gives plugin surfaces no keyboard handling; lift everything above the keyboard. */}
    <View
      style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}
      onLayout={(event) => setSurfaceWidth(event.nativeEvent.layout.width)}
    >
      {layout.compact ? (
        <View ref={paneRef} collapsable={false} style={{ flex: 1 }}>
          {selection ? pane : sidebar}
          {settingsPanel ? <SlideOver onClose={() => setPanel({ open: false, section: panel.section })}>{settingsPanel}</SlideOver> : null}
        </View>
      ) : (
        <>
          <View style={{ width: columns.list, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: nativeTokens(colors).surfaceSidebar }}>
            {sidebar}
            <ResizeHandle side="right" width={columns.list} onResize={(width) => setDragWidths((current) => ({ ...current, list: width }))} onCommit={(width) => commitWidth("listWidth", width)} />
          </View>
          <View ref={paneRef} collapsable={false} style={{ flex: 1, minWidth: 0 }}>{pane}</View>
          {settingsPanel && columns.panel !== null ? (
            <View style={{ width: columns.panel, borderLeftWidth: 1, borderLeftColor: colors.border }}>
              {settingsPanel}
              <ResizeHandle side="left" width={columns.panel} onResize={(width) => setDragWidths((current) => ({ ...current, panel: width }))} onCommit={(width) => commitWidth("panelWidth", width)} />
            </View>
          ) : null}
        </>
      )}

      {creating ? (
        <NewBotDialog
          colors={colors}
          onClose={() => setCreating(false)}
          onCreate={(template) => {
            setCreating(false);
            void addBot(blankBot(defaultProvider(), template), template ? "overview" : "identity");
          }}
          onImport={async (json) => {
            const { bot, skills, mcpServers } = await importBot({ botId: newBotId(), json });
            setCreating(false);
            await addBot(bot, "overview", { skills, mcpServers });
          }}
        />
      ) : null}

      {renaming ? (
        <RenameDialog
          colors={colors}
          title="Rename bot"
          initialValue={renaming.name}
          placeholder={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            if (!(await updateBot(renaming.id, { name }, true))) throw new Error("Unable to save");
            // The identity section holds its own copy of the name.
            if (panel.open && selection?.botId === renaming.id) setPanelVersion((version) => version + 1);
          }}
        />
      ) : null}

      {exporting ? <ExportDialog colors={colors} bot={exporting} onClose={() => setExporting(null)} /> : null}
    </View>
    </>
  );
}

interface SelectedChatProps {
  colors: Colors;
  bot: Bot;
  library: Library;
  selection: Selection;
  localHost: LocalHost;
  panelOpen: boolean;
  layout: PluginSurfaceProps["layout"];
  keyboardOpen: boolean;
  typeVersion: number;
  onBack?(): void;
  onBotMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  onStarted(chatId: string): void;
}

function SelectedChat({ colors, bot, library, selection, localHost, panelOpen, layout, keyboardOpen, typeVersion, onBack, onBotMenu, onTogglePanel, onStarted }: SelectedChatProps) {
  const host = useBotHost(bot.hostId, localHost);
  const chat = useChat(host.api, selection.chatId);
  const ensureHome = useRpc(ensureBotHomeRpc);
  const compose = useRpc(systemPromptRpc);
  const mountApps = useRpc(appsMountRpc);
  const queryClient = useQueryClient();
  const toast = useToast();

  const start = async (message: OutgoingMessage) => {
    if (!host.api) throw new Error(`${host.label} is offline.`);
    // The bot's folder holds its memory and skills even when it works elsewhere.
    const home = await ensureHome({ botId: bot.id });
    const placement = bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root };
    const { systemPrompt } = await compose({ bot, local: host.isLocal });
    // Connected apps go through this host's relay, so only bots here get them.
    const apps = host.isLocal && bot.apps.length ? (await mountApps({ botId: bot.id })).server : null;
    const id = await startBotChat(host.api, {
      bot,
      library,
      apps,
      placement,
      prompt: message.text,
      systemPrompt,
      images: message.images,
      attachments: message.attachments,
      clientMessageId: message.messageId,
    });
    await queryClient.invalidateQueries({ queryKey: ["paseo-bot", "chats", host.key, bot.id] });
    onStarted(id);
  };

  // Keep the bot's workspace named after the bot.
  useEffect(() => {
    if (!host.api || bot.cwd || !bot.name.trim()) return;
    const api = host.api;
    const timer = setTimeout(() => {
      void ensureHome({ botId: bot.id })
        .then((home) => syncBotWorkspaceTitle(api, bot, { path: home.path, projectRoot: home.root }))
        .catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
    // Only the name matters here.
  }, [bot.name, host.api]);

  // "Set up with the bot" opens a new chat that sends its first message straight away.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (selection.chatId !== null || !selection.prompt || autoStarted.current || !host.api) return;
    autoStarted.current = true;
    start({ text: selection.prompt, messageId: newMessageId(), images: [], attachments: [] }).catch((error: unknown) => toast.error(`Couldn't start: ${errorText(error)}`));
    // Runs once for the selection that carries the prompt.
  }, [host.api]);

  return (
    <ChatPane
      colors={colors}
      bot={bot}
      host={host}
      chat={chat}
      chatId={selection.chatId}
      panelOpen={panelOpen}
      layout={layout}
      keyboardOpen={keyboardOpen}
      typeVersion={typeVersion}
      onBack={onBack}
      onBotMenu={onBotMenu}
      onTogglePanel={onTogglePanel}
      onStart={start}
    />
  );
}
