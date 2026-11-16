import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { desktopFrameRpc, desktopInputRpc, desktopPoint, desktopRequestAccessRpc, desktopStartRpc, desktopStatusRpc, desktopStopRpc, type DesktopInput } from "../shared/desktop";
import { errorText } from "./native";
import { ui, useTypeScale } from "./typography";
import { useSurfaceVisibility } from "./useSurfaceVisibility";
import { HeaderButton } from "./ui/HeaderButton";
import { SlideOver } from "./ui/Columns";
import { pressCoordinates } from "./web";

type Connection = { session: string; expiresAt: string; control: boolean };
type Frame = { image: string; width: number; height: number; capturedAt: string };
type ClickMode = "click" | "double" | "right" | "drag";
const KEY_CHOICES: readonly { value: string; label: string; key: Extract<DesktopInput, { kind: "key" }>["key"]; command?: boolean }[] = [
  { value: "return", label: "Enter", key: "return" },
  { value: "tab", label: "Tab", key: "tab" },
  { value: "escape", label: "Escape", key: "escape" },
  { value: "delete", label: "Backspace", key: "delete" },
  { value: "up", label: "Arrow up", key: "up" },
  { value: "down", label: "Arrow down", key: "down" },
  { value: "left", label: "Arrow left", key: "left" },
  { value: "right", label: "Arrow right", key: "right" },
  { value: "address", label: "Address bar (⌘L)", key: "l", command: true },
  { value: "all", label: "Select all (⌘A)", key: "a", command: true },
  { value: "copy", label: "Copy (⌘C)", key: "c", command: true },
  { value: "paste", label: "Paste (⌘V)", key: "v", command: true },
  { value: "undo", label: "Undo (⌘Z)", key: "z", command: true },
];

/** Screenshots and input travel on the same authenticated Paseo connection as bot chats. */
export function DesktopScreen({ theme, host, layout, onBack }: PluginScreenProps & { onBack(): void }) {
  useTypeScale();
  return <DesktopSessionScreen key={host.id} theme={theme} host={host} layout={layout} onBack={onBack} />;
}

function DesktopSessionScreen({ theme, host, layout, onBack }: Pick<PluginScreenProps, "theme" | "host" | "layout"> & { onBack(): void }) {
  const colors = theme.colors;
  const visibility = useSurfaceVisibility();
  const active = visibility.visible;
  const inspect = useRpc(desktopStatusRpc), start = useRpc(desktopStartRpc), stop = useRpc(desktopStopRpc);
  const capture = useRpc(desktopFrameRpc), sendInput = useRpc(desktopInputRpc);
  const requestAccess = useRpc(desktopRequestAccessRpc);
  const status = useQuery({ queryKey: ["bots-desktop-status", host.id], queryFn: () => inspect({}), staleTime: 15_000, retry: false });
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [control, setControl] = useState(false);
  const [displayId, setDisplayId] = useState<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [inputBusy, setInputBusy] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [resolution, setResolution] = useState("1600"), [interval, setIntervalMs] = useState("1500");
  const [text, setText] = useState("");
  const [clickMode, setClickMode] = useState<ClickMode>("click");
  const [selectedKey, setSelectedKey] = useState("return");
  const [dragFrom, setDragFrom] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ width: 1, height: 1 });
  const lastPoint = useRef({ x: 0.5, y: 0.5 });
  const mounted = useRef(true), inputLock = useRef(false);
  const connectLock = useRef(false), connectAttempt = useRef(0);
  const releaseSession = useRef<(() => Promise<unknown>) | null>(null);
  const previousHost = useRef(host.id);
  const rpc = useRef({ capture, stop, sendInput });
  rpc.current = { capture, stop, sendInput };
  const session = connection?.session;
  const selectedDisplay = status.data?.displays.some((display) => display.id === displayId) ? displayId : status.data?.displays[0]?.id ?? null;

  const disconnect = useCallback(() => {
    connectAttempt.current++;
    connectLock.current = false;
    if (releaseSession.current) void releaseSession.current().catch(() => {});
    releaseSession.current = null;
    setConnection(null); setFrame(null); setError(null); setDragFrom(null); setBusy(false); setSettingsOpen(true);
  }, []);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    connectAttempt.current++;
    if (releaseSession.current) void releaseSession.current().catch(() => {});
    releaseSession.current = null;
  }; }, []);
  // Paseo retains previous screens in its navigation stack. Release control
  // when this screen is hidden, even though React has not unmounted it.
  useEffect(() => {
    if (!visibility.isVisible() && (connection || connectLock.current)) disconnect();
  }, [active, connection, disconnect, visibility.isVisible]);
  useEffect(() => {
    if (previousHost.current === host.id) return;
    previousHost.current = host.id;
    disconnect(); setDisplayId(null); setControl(false);
  }, [host.id, disconnect]);
  useEffect(() => {
    if (!connection) return;
    const timer = setTimeout(() => { disconnect(); setError("Desktop session expired. Connect again to continue."); }, Math.max(0, Date.parse(connection.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [connection, disconnect]);
  useEffect(() => {
    setFrame(null);
    setDragFrom(null);
  }, [selectedDisplay, session]);
  useEffect(() => {
    if (!session || selectedDisplay === null || paused || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await rpc.current.capture({ session, displayId: selectedDisplay, maxDimension: Number(resolution) });
        if (disposed) return;
        setFrame(next);
        setError(null);
        timer = setTimeout(() => void tick(), Number(interval));
      } catch (caught) {
        if (!disposed) { setError(errorText(caught)); setPaused(true); }
      }
    };
    void tick();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [session, selectedDisplay, paused, active, resolution, interval, refresh]);

  const connect = async () => {
    if (connectLock.current || !visibility.isVisible()) return;
    connectLock.current = true;
    const attempt = ++connectAttempt.current;
    setBusy(true); setError(null);
    try {
      const next = await start({ control });
      if (!mounted.current || !visibility.isVisible() || connectAttempt.current !== attempt) { await stop({ session: next.session }); return; }
      // Capture this host's RPC; a host switch must release the original host's lease.
      releaseSession.current = () => stop({ session: next.session });
      setConnection(next); setDisplayId(next.status.displays[0]?.id ?? null); setPaused(false); setSettingsOpen(false);
      void status.refetch();
    } catch (caught) { if (mounted.current && connectAttempt.current === attempt) setError(errorText(caught)); }
    finally { if (mounted.current && connectAttempt.current === attempt) { connectLock.current = false; setBusy(false); } }
  };
  const input = async (action: DesktopInput): Promise<boolean> => {
    if (!connection?.control || selectedDisplay === null || inputLock.current || paused || !active || !visibility.isVisible() || !frame) return false;
    inputLock.current = true; setInputBusy(true);
    const attempt = connectAttempt.current;
    try {
      await rpc.current.sendInput({ session: connection.session, displayId: selectedDisplay, input: action });
      if (!mounted.current || connectAttempt.current !== attempt) return false;
      setError(null); setRefresh((value) => value + 1);
      return true;
    } catch (caught) { if (mounted.current && connectAttempt.current === attempt) { setError(errorText(caught)); setPaused(true); } return false; }
    finally { inputLock.current = false; if (mounted.current) setInputBusy(false); }
  };
  const click = (x: number, y: number, bounds = box) => {
    if (!frame) return;
    const point = desktopPoint(x, y, bounds, frame);
    if (!point) return;
    lastPoint.current = point;
    if (clickMode === "drag") {
      if (!dragFrom) setDragFrom(point);
      else { void input({ kind: "drag", ...dragFrom, toX: point.x, toY: point.y }); setDragFrom(null); }
    } else void input({ kind: "click", ...point, count: clickMode === "double" ? 2 : 1, button: clickMode === "right" ? "right" : "left" });
  };
  const key = (key: Extract<DesktopInput, { kind: "key" }>["key"], command = false) => void input({ kind: "key", key, modifiers: command ? ["command"] : [] });
  const ready = !!status.data?.supported && !!status.data.screenRecording && !!status.data.displays.length;
  const canInput = !!connection?.control && !!frame && !inputBusy && !paused && active;

  const accessError = error ?? (status.error ? errorText(status.error) : null);
  useEffect(() => { if (accessError) setSettingsOpen(true); }, [accessError]);
  const requestPermission = () => {
    if (requesting) return;
    setRequesting(true); setError(null);
    void requestAccess({ access: status.data?.screenRecording ? "control" : "screen" })
      .then(() => status.refetch())
      .catch((caught) => { if (mounted.current) setError(errorText(caught)); })
      .finally(() => { if (mounted.current) setRequesting(false); });
  };

  const sidebar = (
    <View accessibilityViewIsModal={layout.compact} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      <View style={{ height: layout.compact ? 56 : 36, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: ui(14), fontWeight: layout.compact ? "400" : "300" }}>Desktop settings</Text>
        <HeaderButton colors={colors} compact={layout.compact} icon="X" label="Close desktop settings" onPress={() => setSettingsOpen(false)} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        <SettingsSection title="Connection" info="Desktop sessions expire after 15 minutes.">
          <SettingsCard>
            <SettingsRow label="Host" hint={host.label} />
            <SettingsRow
              label="Access"
              hint={status.isPending ? "Checking access…" : status.data?.message ?? (ready ? "Screen recording is allowed." : "Desktop access is unavailable.")}
              error={accessError}
            />
            <SettingsAction label="Check host access" actionLabel={status.isFetching ? "Checking…" : "Check"} disabled={status.isFetching} onPress={() => void status.refetch()} />
            {!connection ? (
              <>
                <SettingsSwitch
                  label="Control the host"
                  hint={status.data?.accessibility ? "Click, scroll, drag and type in the host’s apps." : "Requires Accessibility for the app macOS identifies: Paseo or Paseo Helper."}
                  value={control}
                  onValueChange={setControl}
                  disabled={busy}
                />
                {status.data?.supported && (!status.data.screenRecording || (control && !status.data.accessibility)) ? (
                  <SettingsAction
                    label={status.data.screenRecording ? "Accessibility permission" : "Screen recording permission"}
                    hint="Allow access in the host’s System Settings."
                    actionLabel={requesting ? "Opening…" : "Open settings"}
                    disabled={requesting}
                    onPress={requestPermission}
                  />
                ) : null}
                <SettingsAction
                  label={control ? "Connect with control" : "Connect to view"}
                  actionLabel={busy ? "Connecting…" : "Connect"}
                  disabled={busy || !ready || (control && !status.data?.accessibility)}
                  onPress={() => void connect()}
                />
              </>
            ) : (
              <>
                <SettingsRow label={connection.control ? "Control enabled" : "View only"} hint={`Expires at ${new Date(connection.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`} />
                <SettingsAction label="Disconnect from the desktop" actionLabel="Disconnect" onPress={disconnect} />
              </>
            )}
          </SettingsCard>
        </SettingsSection>
        {connection ? (
          <>
            <SettingsSection title="Screen">
              <SettingsCard>
                <SettingsSwitch
                  label="Pause view"
                  hint={frame ? `Updated ${new Date(frame.capturedAt).toLocaleTimeString()}` : "Loading screen…"}
                  value={paused}
                  onValueChange={(value) => { setPaused(value); setDragFrom(null); }}
                />
                <SettingsSelect label="Display" value={String(selectedDisplay)} options={(status.data?.displays ?? []).map((display) => ({ label: `${display.name} · ${display.width} × ${display.height}`, value: String(display.id) }))} onValueChange={(value) => setDisplayId(Number(value))} />
                <SettingsSelect label="Image size" value={resolution} options={[{ label: "960 px", value: "960" }, { label: "1600 px", value: "1600" }, { label: "2560 px", value: "2560" }]} onValueChange={setResolution} />
                <SettingsSelect label="Refresh" value={interval} options={[{ label: "Every second", value: "1000" }, { label: "Every 1.5 seconds", value: "1500" }, { label: "Every 3 seconds", value: "3000" }, { label: "Every 5 seconds", value: "5000" }]} onValueChange={setIntervalMs} />
              </SettingsCard>
            </SettingsSection>
            {connection.control ? (
              <>
                <SettingsSection title="Pointer" info={clickMode === "drag" ? dragFrom ? "Click the destination to finish the drag." : "Click the starting point, then the destination." : "Click the screen to use the selected action."}>
                  <SettingsCard>
                    <SettingsSelect<ClickMode> label="Action" value={clickMode} options={[{ label: "Click", value: "click" }, { label: "Double click", value: "double" }, { label: "Right click", value: "right" }, { label: "Drag", value: "drag" }]} onValueChange={(mode) => { setClickMode(mode); setDragFrom(null); }} />
                    <SettingsAction label="Scroll up" actionLabel="Scroll" disabled={!canInput} onPress={() => void input({ kind: "scroll", ...lastPoint.current, delta: 4 })} />
                    <SettingsAction label="Scroll down" actionLabel="Scroll" disabled={!canInput} onPress={() => void input({ kind: "scroll", ...lastPoint.current, delta: -4 })} />
                  </SettingsCard>
                </SettingsSection>
                <SettingsSection title="Keyboard">
                  <SettingsCard>
                    <SettingsSelect label="Key or shortcut" value={selectedKey} options={KEY_CHOICES} onValueChange={setSelectedKey} />
                    <SettingsAction label="Send key to the host" actionLabel="Send" disabled={!canInput} onPress={() => { const choice = KEY_CHOICES.find((entry) => entry.value === selectedKey); if (choice) key(choice.key, choice.command); }} />
                    <SettingsRow label="Text" hint="Type into the focused app on the host.">
                      <TextInput
                        accessibilityLabel="Text to type on the host"
                        placeholder="Text to type…"
                        value={text}
                        onChangeText={setText}
                        multiline
                        maxLength={4000}
                        editable={!inputBusy}
                        style={{ minHeight: 72, color: colors.foreground, fontSize: ui(14), textAlignVertical: "top" }}
                      />
                    </SettingsRow>
                    <SettingsAction label="Type text on the host" actionLabel={inputBusy ? "Typing…" : "Type"} disabled={!canInput || !text.length} onPress={() => { const sent = text; void input({ kind: "text", text: sent }).then((ok) => { if (ok) setText((current) => current === sent ? "" : current); }); }} />
                  </SettingsCard>
                </SettingsSection>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );

  return (
    <View ref={visibility.ref} collapsable={false} style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surface0 }}>
      <View style={{ height: layout.compact ? 44 : 36, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <HeaderButton colors={colors} compact={layout.compact} icon="ArrowLeft" label="Back to Bots" onPress={onBack} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: ui(14), fontWeight: layout.compact ? "400" : "300" }}>Host desktop</Text>
        {!layout.compact ? <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: ui(14) }}>{host.label}</Text> : null}
        <View style={{ flex: 1 }} />
        {connection ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>{paused ? "Paused" : connection.control ? "Control enabled" : "View only"}</Text> : null}
        <HeaderButton colors={colors} compact={layout.compact} icon="PanelRight" label={settingsOpen ? "Hide desktop settings" : "Show desktop settings"} expanded={settingsOpen} onPress={() => setSettingsOpen((open) => !open)} />
      </View>
      <View style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: "row" }}>
        <Pressable
          accessibilityRole={connection?.control ? "button" : "image"}
          accessibilityLabel={connection?.control ? "Host screen. Click to control the selected display." : "Host screen"}
          accessibilityElementsHidden={layout.compact && settingsOpen}
          importantForAccessibility={layout.compact && settingsOpen ? "no-hide-descendants" : "auto"}
          disabled={!canInput || (layout.compact && settingsOpen)}
          onPress={(event) => { const point = pressCoordinates(event); if (point) click(point.x, point.y, point.box); }}
          onLayout={(event) => { setBox(event.nativeEvent.layout); setDragFrom(null); }}
          style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", alignItems: "center", justifyContent: "center" }}
        >
          {frame ? <View pointerEvents="none" style={{ width: "100%", height: "100%" }}><Image accessibilityIgnoresInvertColors source={{ uri: frame.image }} resizeMode="contain" style={{ width: "100%", height: "100%" }} /></View> : connection || busy ? <Loading /> : <Text style={{ padding: 24, color: colors.foregroundMuted, fontSize: ui(14), textAlign: "center" }}>Connect using Desktop settings.</Text>}
        </Pressable>
        {settingsOpen ? layout.compact ? <SlideOver onClose={() => setSettingsOpen(false)}>{sidebar}</SlideOver> : <View style={{ width: 320, minHeight: 0, borderLeftWidth: 1, borderLeftColor: colors.border }}>{sidebar}</View> : null}
      </View>
    </View>
  );
}
