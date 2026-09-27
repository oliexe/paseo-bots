import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent, PaseoAgentSendOptions } from "@getpaseo/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View, useWindowDimensions, type TextInput as NativeTextInput } from "react-native";
import { newAttachmentId, normalizeMimeType, preflightFile, toWire, type ComposerAttachment } from "../../shared/attachments";
import type { Bot } from "../../shared/bot";
import { uploadRpc } from "../../shared/rpc";
import { expandLearn, LEARN_COMMAND } from "../../shared/skills";
import { AttachmentPill, PendingAttachmentPill } from "../AttachmentPill";
import type { BotHost } from "../data";
import { homeIndicatorInset } from "../keyboard";
import { CONTENT_MAX_WIDTH, errorText, nativeTokens, placeholderColor, useHover } from "../native";
import { newMessageId, rememberSent } from "../sent-attachments";
import { measureAnchor, useMenu, type MenuEntry } from "../ui/Menu";
import { decodeUtf8, domNode, focusWithRetries, listenForFileDrop, listenForImagePaste, pickFileHandles, type FileHandle } from "../web";
import { content, ui } from "../typography";
import type { ChatPaneProps, OutgoingMessage } from "../ChatPane";
import { CommandMenu } from "./composer/CommandMenu";
import { ContextMeter } from "./composer/ContextMeter";
import { getDraft, loadDrafts, queueMessage, requeueFront, setDraft, takeQueuedMessage, useQueue } from "./composer/drafts";
import { useInputHeight } from "./composer/height";
import {
  activeTurnBehaviorFor,
  applyCommand,
  commandQuery,
  composerDraftKey,
  contextUsage,
  filterCommands,
  isImeComposing,
  MIN_INPUT_HEIGHT_NATIVE,
  MIN_INPUT_HEIGHT_WEB,
  resolveActiveSendBehavior,
  resolveAlternateAction,
  resolveDefaultAction,
  resolveEnterKey,
  resolveMaxInputHeight,
  resolvePrimaryAction,
  restoreFailedSend,
  shouldDrainQueue,
  submitAccessibilityLabel,
  type ComposerKeyEvent,
  type QueuedMessage,
  type SendAction,
  type SlashCommand,
  withPluginCommands,
} from "./composer/logic";
import { useSendBehavior } from "./composer/storage";

type Colors = PluginTheme["colors"];
type Permission = PaseoAgent["pendingPermissions"][number];

const web = Platform.OS === "web";
/** Paseo's palette: red-600 for the stop button, red-500 for inline send errors. */
const RED_600 = "#dc2626";
const RED_500 = "#ef4444";
const FAILED_TO_SEND = "Failed to send message";

interface ComposerProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  agentId: string | null;
  running: boolean;
  layout: ChatPaneProps["layout"];
  keyboardOpen: boolean;
  /** The chat's live agent snapshot: pending permissions (stop), last usage (context meter). */
  agent?: PaseoAgent | null;
  onStart(message: OutgoingMessage): Promise<void>;
}

/** One composer per chat, so each chat keeps its own draft, height and queue. */
export function Composer(props: ComposerProps) {
  const draftKey = composerDraftKey(props.host.key, props.bot.id, props.agentId);
  return <ChatComposer key={draftKey} draftKey={draftKey} {...props} />;
}

const PLUGIN_COMMANDS: SlashCommand[] = [{ ...LEARN_COMMAND, kind: "command" }];

// Commands are listed per live session; cache them per agent for the session.
const commandCache = new Map<string, Promise<{ commands: SlashCommand[]; error: string | null }>>();

// Paseo's composer (composer/index.tsx + composer/input/input.tsx): the queue track and any
// send error above a surface1 card with a borderAccent frame, radius 16; attachment tray,
// auto-growing input, then a toolbar with "Add attachment" on the left and the context
// meter and send/stop button on the right.
function ChatComposer({ colors, bot, host, agentId, running, layout, keyboardOpen, agent, onStart, draftKey }: ComposerProps & { draftKey: string }) {
  const toast = useToast();
  const menu = useMenu();
  const upload = useRpc(uploadRpc);
  const tokens = nativeTokens(colors);
  const { height: windowHeight } = useWindowDimensions();
  const initial = useMemo(() => getDraft(draftKey), [draftKey]);
  const [text, setText] = useState(initial?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(initial?.attachments ?? []);
  const [pending, setPending] = useState<{ id: string; name: string }[]>([]);
  const [processing, setProcessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [drain, setDrain] = useState<"idle" | "sending" | "awaiting" | "paused">("idle");
  const [commandState, setCommandState] = useState<{ agentId: string; commands: SlashCommand[]; error: string | null } | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);

  const inputRef = useRef<NativeTextInput>(null);
  const outerRef = useRef<View>(null);
  const attachRef = useRef<View>(null);
  const mounted = useRef(true);
  const touched = useRef(false);
  const latest = useRef({ text, attachments });
  latest.current = { text, attachments };

  const sendBehavior = useSendBehavior();
  const permissions: Permission[] = agent?.pendingPermissions ?? [];
  const behavior = resolveActiveSendBehavior(sendBehavior, permissions.length > 0);
  const queue = useQueue(draftKey);
  const canQueue = agentId !== null;
  const desktopWeb = layout.platform === "web" && !layout.compact;
  const buttonIconSize = web ? 16 : 20;
  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const loading = processing || pending.length > 0;
  const canInterrupt = running && permissions.length > 0 && agentId !== null && !!host.api;
  const canPressLoading = loading && canInterrupt;
  const sendDisabled = !host.api || (!canPressLoading && loading);
  const primary = resolvePrimaryAction({ hasContent, running, loading });
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ------------------------------------------------------------ drafts

  const updateText = (next: string) => {
    touched.current = true;
    setText(next);
  };
  const updateAttachments = (update: (current: ComposerAttachment[]) => ComposerAttachment[]) => {
    touched.current = true;
    setAttachments(update);
  };

  // Phones read drafts from AsyncStorage after the first render; apply it unless the user already typed.
  useEffect(() => {
    let alive = true;
    void loadDrafts().then(() => {
      if (!alive || touched.current) return;
      const draft = getDraft(draftKey);
      if (draft) {
        setText(draft.text);
        setAttachments(draft.attachments);
      }
    });
    return () => {
      alive = false;
    };
  }, [draftKey]);

  useEffect(() => {
    if (touched.current) setDraft(draftKey, { text, attachments });
  }, [draftKey, text, attachments]);

  // ------------------------------------------------------------ input

  const minHeight = web ? MIN_INPUT_HEIGHT_WEB : MIN_INPUT_HEIGHT_NATIVE;
  const inputHeight = useInputHeight(inputRef, text, minHeight, resolveMaxInputHeight(windowHeight), content());
  const focusInput = () => {
    if (web) focusWithRetries(() => domNode(inputRef.current));
    else inputRef.current?.focus();
  };

  // Desktop web focuses the composer when a chat opens (Paseo's MessageInputAutoFocus).
  useEffect(() => (desktopWeb ? focusWithRetries(() => domNode(inputRef.current)) : undefined), []);

  // ------------------------------------------------------------ attachments

  const addFiles = async (files: FileHandle[]) => {
    const accepted: { file: FileHandle; kind: ComposerAttachment["kind"]; mimeType: string; pendingId: string }[] = [];
    for (const file of files) {
      const mimeType = normalizeMimeType(file.mimeType) || "application/octet-stream";
      // Size limits are checked before any bytes are read.
      const { kind, reason } = preflightFile(file.name, mimeType, file.size, host.isLocal);
      if (reason) {
        toast.error(`${file.name}: ${reason}`);
        continue;
      }
      accepted.push({ file, kind, mimeType, pendingId: newAttachmentId() });
    }
    if (accepted.length === 0) return;
    setPending((current) => [...current, ...accepted.map((entry) => ({ id: entry.pendingId, name: entry.file.name }))]);
    for (const { file, kind, mimeType, pendingId } of accepted) {
      try {
        const base64 = await file.readBase64();
        let attachment: ComposerAttachment;
        if (kind === "image") attachment = { kind, id: newAttachmentId(), name: file.name, mimeType, size: file.size, data: base64 };
        else if (kind === "text") attachment = { kind, id: newAttachmentId(), name: file.name, size: file.size, text: decodeUtf8(base64) };
        else {
          const stored = await upload({ botId: bot.id, fileName: file.name, dataBase64: base64 });
          attachment = { kind, id: newAttachmentId(), name: file.name, mimeType, size: stored.size, path: stored.path };
        }
        if (mounted.current) updateAttachments((current) => [...current, attachment]);
        else setDraft(draftKey, { text: latest.current.text, attachments: [...latest.current.attachments, attachment] });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to upload file");
      } finally {
        if (mounted.current) setPending((current) => current.filter((entry) => entry.id !== pendingId));
      }
    }
  };

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const pick = async (accept?: string) => {
    try {
      await addFiles(await pickFileHandles({ accept }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload file");
    }
  };

  const openAttachMenu = async () => {
    const anchor = await measureAnchor(attachRef);
    if (!anchor) return;
    // Paseo's order: Add image, Paste image (phones), issues/PRs, plugin sources, Upload file.
    // Plugins can't read the clipboard or open pickers on phones, so pasting text stands in there.
    const entries: MenuEntry[] = web
      ? [
          { label: "Add image", icon: "Image", onSelect: () => void pick("image/*") },
          { label: "Upload file", icon: "Paperclip", onSelect: () => void pick() },
        ]
      : [{ label: "Paste text", icon: "ClipboardPaste", onSelect: () => setPasting(true) }];
    menu.open({ anchor, align: "start", width: 220, title: "Add attachment", entries });
  };

  // Web: pasting images into the input attaches them.
  useEffect(() => listenForImagePaste(domNode(inputRef.current), (files) => void addFilesRef.current(files)), []);

  // Web: dropping files anywhere on the chat pane attaches them (Paseo's FileDropZone).
  useEffect(() => {
    const own = domNode(outerRef.current);
    return listenForFileDrop(own?.parentElement ?? own, {
      label: "Drop files here",
      background: colors.surface0,
      foreground: colors.foreground,
      isEnabled: () => !loadingRef.current && !!host.api,
      onFiles: (files) => void addFilesRef.current(files),
    });
  }, [colors.surface0, colors.foreground, host.api]);

  // ------------------------------------------------------------ sending

  const deliver = async (message: { text: string; attachments: ComposerAttachment[] }) => {
    const typed = message.text.trim();
    // /learn only works where the plugin's tools are mounted (bots on this host).
    const outgoing = (agentId && host.isLocal ? expandLearn(typed) : null) ?? (typed || "See the attached files.");
    const messageId = newMessageId();
    const wire = toWire(message.attachments);
    rememberSent(messageId, outgoing, message.attachments);
    if (agentId && host.api) {
      // `activeTurnBehavior` is forwarded to the daemon as-is (send_agent_message_request).
      const options = {
        messageId,
        activeTurnBehavior: activeTurnBehaviorFor(sendBehavior),
        ...(wire.images.length ? { images: wire.images } : {}),
        ...(wire.attachments.length ? { attachments: wire.attachments } : {}),
      } as PaseoAgentSendOptions;
      await host.api.agents.ref(agentId).send(outgoing, options);
    } else {
      await onStart({ text: outgoing, messageId, ...wire });
    }
  };

  const errorMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : FAILED_TO_SEND);

  // composer/submit.ts: clear at once so typing can continue, put everything back on failure.
  const send = async () => {
    const message = { text: text.trim(), attachments };
    if ((!message.text && message.attachments.length === 0) || !host.api) return;
    updateText("");
    updateAttachments(() => []);
    setSendError(null);
    setProcessing(true);
    if (drain === "paused") setDrain("idle");
    try {
      await deliver(message);
      // Give the agent a moment to report the new turn before any queued message drains.
      if (agentId && mounted.current) setDrain((current) => (current === "idle" ? "awaiting" : current));
    } catch (error) {
      const restored = restoreFailedSend(message, latest.current);
      if (mounted.current) {
        updateText(restored.text);
        updateAttachments(() => restored.attachments);
        setSendError(errorMessage(error));
      } else {
        setDraft(draftKey, restored);
        toast.error(errorMessage(error));
      }
    } finally {
      if (mounted.current) setProcessing(false);
    }
  };

  const enqueue = () => {
    const message = { text: text.trim(), attachments };
    if (!message.text && message.attachments.length === 0) return;
    queueMessage(draftKey, { id: newMessageId(), ...message });
    updateText("");
    updateAttachments(() => []);
  };

  const run = (action: SendAction) => {
    if (action === "queue") enqueue();
    else if (action === "send") void send();
  };
  const defaultAction = () => run(resolveDefaultAction({ behavior, running, canQueue }));
  const alternateAction = () => run(resolveAlternateAction({ behavior, running, canQueue }));

  // Queued messages go out one at a time whenever the agent is idle (Paseo drains on "stopped running").
  useEffect(() => {
    if (running && (drain === "awaiting" || drain === "paused")) setDrain("idle");
  }, [running, drain]);
  useEffect(() => {
    if (drain !== "awaiting") return;
    const timer = setTimeout(() => setDrain((current) => (current === "awaiting" ? "idle" : current)), 4000);
    return () => clearTimeout(timer);
  }, [drain]);
  const draining = useRef(false);
  useEffect(() => {
    const inFlight = draining.current || drain !== "idle" || processing;
    if (!shouldDrainQueue({ running, queued: queue.length, inFlight, hasAgent: agentId !== null && !!host.api })) return;
    const next = takeQueuedMessage(draftKey, queue[0]!.id);
    if (!next) return;
    draining.current = true;
    setDrain("sending");
    deliver(next)
      .then(() => mounted.current && setDrain("awaiting"))
      .catch((error: unknown) => {
        requeueFront(draftKey, next);
        if (!mounted.current) return;
        setSendError(errorMessage(error));
        setDrain("paused");
      })
      .finally(() => {
        draining.current = false;
      });
  }, [running, queue, drain, processing, agentId, host.api]);

  const sendQueuedNow = async (item: QueuedMessage) => {
    if (!host.api || !takeQueuedMessage(draftKey, item.id)) return;
    setSendError(null);
    try {
      await deliver(item);
    } catch (error) {
      requeueFront(draftKey, item);
      if (mounted.current) setSendError(errorMessage(error));
    }
  };

  const editQueued = (item: QueuedMessage) => {
    if (!takeQueuedMessage(draftKey, item.id)) return;
    updateText(item.text);
    updateAttachments(() => item.attachments);
    focusInput();
  };

  // ------------------------------------------------------------ stop

  // Plugins have no cancel API. The one interrupt path is a pending permission: denying it
  // with `interrupt` ends the turn, which is what Paseo's stop does in that state.
  const stop = async () => {
    const permission = permissions[0];
    if (!canInterrupt || !permission || !agentId || !host.api || stopping) return;
    setStopping(true);
    try {
      await host.api.agents.ref(agentId).respondToPermission({ requestId: permission.id, response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." } });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      if (mounted.current) setStopping(false);
    }
    focusInput();
  };

  // ------------------------------------------------------------ /commands

  const query = agentId ? commandQuery(text) : null;
  const commandsVisible = query !== null && !commandsDismissed;
  useEffect(() => {
    if (query === null) setCommandsDismissed(false);
    setActiveCommand(0);
  }, [query]);
  useEffect(() => {
    if (!commandsVisible || !agentId || !host.api || commandState?.agentId === agentId) return;
    const api = host.api;
    let promise = commandCache.get(agentId);
    if (!promise) {
      promise = api.agents
        .ref(agentId)
        .commands()
        .then((result) => ({ commands: result.commands as SlashCommand[], error: result.error }))
        .catch((error: unknown) => ({ commands: [], error: errorText(error) }));
      commandCache.set(agentId, promise);
      // Don't cache failures: the next chat visit asks again.
      void promise.then((result) => result.error && commandCache.delete(agentId));
    }
    let alive = true;
    void promise.then((result) => alive && setCommandState({ agentId, ...result }));
    return () => {
      alive = false;
    };
  }, [commandsVisible, agentId, host.api]);
  const providerCommands = commandState?.agentId === agentId ? commandState.commands : [];
  const commandList = commandsVisible ? filterCommands(withPluginCommands(host.isLocal ? PLUGIN_COMMANDS : [], providerCommands), query ?? "") : [];
  const selectCommand = (command: SlashCommand) => {
    updateText(applyCommand(command));
    setCommandsDismissed(true);
    focusInput();
  };

  // ------------------------------------------------------------ keys

  const onKeyPress = (event: { nativeEvent: unknown; preventDefault?: () => void }) => {
    if (layout.platform !== "web") return;
    const key = event.nativeEvent as ComposerKeyEvent;
    if (isImeComposing(key)) return;
    const consume = (effect: () => void) => {
      event.preventDefault?.();
      effect();
    };
    const count = commandList.length;
    if (commandsVisible && count > 0) {
      if (key.key === "ArrowDown") return consume(() => setActiveCommand((index) => (index + 1) % count));
      if (key.key === "ArrowUp") return consume(() => setActiveCommand((index) => (index - 1 + count) % count));
      if ((key.key === "Enter" && !key.shiftKey) || key.key === "Tab") return consume(() => selectCommand(commandList[Math.min(activeCommand, count - 1)]!));
    }
    if (commandsVisible && key.key === "Escape") return consume(() => setCommandsDismissed(true));
    // Paseo's Escape shortcut interrupts the agent.
    if (key.key === "Escape" && canInterrupt) return consume(() => void stop());
    const action = resolveEnterKey(key, { submitOnEnter: desktopWeb, running, canQueue });
    // While a send or upload is in flight Enter falls through to a newline, like Paseo.
    if (!action || sendDisabled || loading) return;
    consume(action === "alternate" ? alternateAction : defaultAction);
  };

  // ------------------------------------------------------------ render

  const bottomInset = keyboardOpen ? 0 : homeIndicatorInset();
  const usage = contextUsage(agent?.lastUsage);
  const placeholder = agentId ? (layout.compact ? "Message, /commands" : `Message ${bot.name}, or use /commands and /skills`) : `Message ${bot.name}`;
  const webInputStyle = web ? ({ lineHeight: content() * 1.4, outlineStyle: "none", outlineWidth: 0 } as object) : null;

  return (
    <View ref={outerRef} collapsable={false} style={{ width: "100%", minHeight: 75, alignItems: "center", paddingHorizontal: 16, paddingBottom: 16 + bottomInset, flexShrink: 1 }}>
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, gap: 12, flexShrink: 1 }}>
        {queue.length > 0 ? (
          <View style={{ gap: 8 }}>
            {queue.map((item) => (
              <QueuedRow key={item.id} colors={colors} item={item} onEdit={() => editQueued(item)} onSendNow={() => void sendQueuedNow(item)} />
            ))}
          </View>
        ) : null}
        {sendError ? (
          <Text accessibilityRole="alert" style={{ color: RED_500, fontSize: ui(14) }}>
            {sendError}
          </Text>
        ) : null}
        <View style={{ position: "relative", width: "100%", flexShrink: 1 }}>
          {commandsVisible ? (
            <CommandMenu
              colors={colors}
              commands={commandList}
              activeIndex={activeCommand}
              loading={commandState?.agentId !== agentId}
              error={commandState?.agentId === agentId ? commandState.error : null}
              onHover={setActiveCommand}
              onSelect={selectCommand}
            />
          ) : null}
          <View
            style={{
              flexShrink: 1,
              gap: 12,
              backgroundColor: colors.surface1,
              borderWidth: 1,
              borderColor: tokens.borderAccent,
              borderRadius: 16,
              paddingVertical: layout.compact ? 8 : 16,
              paddingHorizontal: layout.compact ? 12 : 16,
            }}
          >
            {attachments.length > 0 || pending.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {attachments.map((attachment) => (
                  <AttachmentPill
                    key={attachment.id}
                    colors={colors}
                    attachment={attachment}
                    alwaysShowRemove={!web || layout.compact}
                    disabled={processing}
                    onRemove={() => updateAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}
                  />
                ))}
                {pending.map((entry) => (
                  <PendingAttachmentPill key={entry.id} colors={colors} name={entry.name} />
                ))}
              </View>
            ) : null}
            <TextInput
              ref={inputRef}
              accessibilityLabel={`Message ${bot.name}`}
              value={text}
              onChangeText={updateText}
              placeholder={placeholder}
              placeholderTextColor={placeholderColor(colors)}
              multiline
              scrollEnabled={inputHeight.scrollEnabled}
              editable={!!host.api}
              onKeyPress={onKeyPress}
              style={[
                { flexShrink: 1, width: "100%", color: colors.foreground, fontSize: content(), fontWeight: "normal", padding: 0, textAlignVertical: "top" },
                webInputStyle,
                inputHeight.style,
              ]}
            />
            <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginHorizontal: -6 }}>
              <View style={{ minWidth: 0, flexShrink: 1, flexGrow: 1, flexDirection: "row", alignItems: "flex-end" }}>
                <AttachButton colors={colors} anchorRef={attachRef} iconSize={buttonIconSize} disabled={!host.api} onPress={() => void openAttachMenu()} />
              </View>
              <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
                {agentId ? (
                  <View style={{ width: 28, height: 28, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
                    <ContextMeter
                      colors={colors}
                      usage={usage}
                      pending={agent?.status === "initializing" || running}
                      glyphSize={layout.compact ? 16 : buttonIconSize}
                    />
                  </View>
                ) : null}
                {primary === "send" ? (
                  <RoundButton
                    label={submitAccessibilityLabel({ canPressLoading, behavior, running })}
                    background={colors.accent}
                    disabled={sendDisabled}
                    onPress={canPressLoading ? () => void stop() : defaultAction}
                  >
                    {loading ? <ActivityIndicator size="small" color={colors.accentForeground} /> : <Icon name="ArrowUp" size={buttonIconSize} color={colors.accentForeground} />}
                  </RoundButton>
                ) : primary === "active" && canInterrupt ? (
                  <RoundButton label={stopping ? "Canceling agent" : "Stop agent"} background={RED_600} disabled={stopping} onPress={() => void stop()}>
                    {stopping ? <ActivityIndicator size="small" color="#ffffff" /> : <FilledSquare size={buttonIconSize} />}
                  </RoundButton>
                ) : null}
              </View>
            </View>
          </View>
        </View>
      </View>
      {pasting ? (
        <PasteTextSheet
          colors={colors}
          onClose={() => setPasting(false)}
          onAttach={(pasted, title) => {
            updateAttachments((current) => [...current, { kind: "text", id: newAttachmentId(), name: title, size: pasted.length, text: pasted }]);
            setPasting(false);
          }}
        />
      ) : null}
    </View>
  );
}

/** Paseo's "Add attachment" trigger: 28 round, Plus muted, foreground and surface2 on hover. */
function AttachButton({ colors, anchorRef, iconSize, disabled, onPress }: { colors: Colors; anchorRef: RefObject<View | null>; iconSize: number; disabled: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add attachment"
      disabled={disabled}
      onPress={onPress}
      {...hoverProps}
      style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? colors.surface2 : "transparent", opacity: disabled ? 0.5 : 1 }}
    >
      <View ref={anchorRef} collapsable={false} style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
        <Icon name="Plus" size={iconSize} color={hovered ? colors.foreground : colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

/** Paseo's 28pt round send / stop button. */
function RoundButton({ label, background, disabled, onPress, children }: { label: string; background: string; disabled: boolean; onPress(): void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{ width: 28, height: 28, borderRadius: 14, marginLeft: 4, alignItems: "center", justifyContent: "center", backgroundColor: background, opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </Pressable>
  );
}

/** Lucide's Square filled white (the plugin Icon has no fill): an 18/24 box with a 2/24 radius. */
function FilledSquare({ size }: { size: number }) {
  const side = Math.round((size * 18) / 24);
  return <View style={{ width: side, height: side, borderRadius: (size * 2) / 24, backgroundColor: "#ffffff" }} />;
}

/** Paseo's queued message row: text over two lines, a pencil to edit and an accent arrow to send now. */
function QueuedRow({ colors, item, onEdit, onSendNow }: { colors: Colors; item: QueuedMessage; onEdit(): void; onSendNow(): void }) {
  const label = item.text || item.attachments.map((attachment) => attachment.name).join(", ");
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.surface1,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text numberOfLines={2} ellipsizeMode="tail" style={{ flex: 1, color: colors.foreground, fontSize: ui(14) }}>
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit queued message"
          onPress={onEdit}
          style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 }}
        >
          <Icon name="Pencil" size={14} color={colors.foreground} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send queued message now"
          onPress={onSendNow}
          style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}
        >
          <Icon name="ArrowUp" size={14} color={colors.accentForeground} />
        </Pressable>
      </View>
    </View>
  );
}

/** Phones have no file picker or clipboard access for plugins, so "Paste text" attaches pasted text there. */
function PasteTextSheet({ colors, onClose, onAttach }: { colors: Colors; onClose(): void; onAttach(text: string, title: string): void }) {
  const [text, setText] = useState("");
  const tokens = nativeTokens(colors);
  return (
    <Modal title="Paste text" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsRow label="Text" hint="Pasted notes, an email, a log… sent alongside your message. Images and files can be attached from Paseo on desktop or the web.">
            <TextInput
              accessibilityLabel="Text to attach"
              value={text}
              onChangeText={setText}
              multiline
              placeholder="Paste here"
              placeholderTextColor={placeholderColor(colors)}
              style={{
                width: "100%",
                minHeight: 140,
                color: colors.foreground,
                backgroundColor: colors.surface1,
                borderColor: tokens.borderAccent,
                borderWidth: 1,
                borderRadius: 8,
                padding: 10,
                fontSize: ui(14),
                textAlignVertical: "top",
              }}
            />
          </SettingsRow>
          <SettingsAction label="Attach it to the message" actionLabel="Attach" disabled={!text.trim()} onPress={() => onAttach(text, `Pasted text (${text.trim().split(/\s+/).length} words)`)} />
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}
