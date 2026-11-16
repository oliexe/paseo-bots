import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStream, type ChatStreamProps } from "../client/chat/Stream";
import type { ChatState } from "../client/useChat";

const mocked = vi.hoisted(() => ({
  list: { scrollToOffset: vi.fn(), scrollToIndex: vi.fn(), scrollToEnd: vi.fn() },
  measuredEnd: vi.fn(),
  resize: null as (() => void) | null,
  disconnect: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" }, View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator",
  Animated: { Value: class { setValue() {} }, View: "AnimatedView", timing: () => ({ start: (done: (state: { finished: boolean }) => void) => done({ finished: true }), stop: () => {} }) },
}));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return {
    FlatList: React.forwardRef((props: object, ref) => { React.useImperativeHandle(ref, () => mocked.list); return React.createElement("FlatList", props); }),
    Icon: "Icon", useToast: () => ({ error: vi.fn() }),
  };
});
vi.mock("../client/chat/Permission", () => ({ PermissionCard: "PermissionCard" }));
vi.mock("../client/chat/FindBar", () => ({ FindBar: "FindBar" }));
vi.mock("../client/chat/stream/rows", () => ({ CompletedTurnFooter: "CompletedTurnFooter", RowContent: "RowContent", RowFrame: "RowFrame", WorkingIndicator: "WorkingIndicator" }));
vi.mock("../client/chat/stream/ui", () => ({ SecondaryButton: "SecondaryButton" }));
vi.mock("../client/native", () => ({ CONTENT_MAX_WIDTH: 800, nativeTokens: () => ({ dark: true }) }));
vi.mock("../client/typography", () => ({ ui: (size: number) => size }));
vi.mock("../client/speech", () => ({ canSpeak: false, speak: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("../client/sent-attachments", () => ({ sentAttachments: () => [] }));
vi.mock("../client/ui/Tooltip", () => ({ tooltip: () => ({}) }));
vi.mock("../client/web", () => ({
  scrollWebListToEnd: mocked.measuredEnd,
  watchWebListSize: (_list: unknown, changed: () => void) => { mocked.resize = changed; changed(); return mocked.disconnect; },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer | undefined;
beforeEach(() => { vi.clearAllMocks(); mocked.resize = null; });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; });

const entries = [
  { seqStart: 1, seqEnd: 1, timestamp: new Date(0).toISOString(), provider: "claude", item: { type: "user_message", text: "old prompt" } },
  { seqStart: 2, seqEnd: 2, timestamp: new Date(1).toISOString(), provider: "claude", item: { type: "assistant_message", text: "latest answer" } },
] as ChatState["entries"];

async function mount(overrides: Partial<ChatStreamProps> = {}) {
  const chat: ChatState = { entries, agent: null, loading: false, error: null, hasOlder: true, loadingOlder: false, retrying: false, loadOlder: vi.fn(), retry: vi.fn() };
  const props: ChatStreamProps = { colors: {} as ChatStreamProps["colors"], chat, api: null, agentId: "chat", compact: false, platform: "web", typeVersion: 0, ...overrides };
  await act(async () => { root = create(<ChatStream {...props} />); });
  return {
    props,
    list: () => root!.root.findByType("FlatList" as never).props,
    surface: () => root!.root.findAllByType("View" as never)[0]!.props,
    update: async (patch: Partial<ChatStreamProps>) => { Object.assign(props, patch); await act(async () => { root!.update(<ChatStream {...props} />); }); },
  };
}

const scrolled = (offset = 0, height = 2000, viewport = 500) => ({ nativeEvent: { contentOffset: { y: offset }, contentSize: { height }, layoutMeasurement: { height: viewport } } });

describe("opening chat scroll position", () => {
  it("keeps following late measurements after an initial estimated scroll lands above the end", async () => {
    const view = await mount();
    await act(async () => { view.list().onLayout({ nativeEvent: { layout: { height: 500 } } }); view.list().onScroll(scrolled(1100)); });
    mocked.measuredEnd.mockClear();
    await act(async () => { view.list().onContentSizeChange(800, 2300); mocked.resize?.(); });
    expect(mocked.measuredEnd).toHaveBeenCalledTimes(2);
    expect(view.props.chat.loadOlder).not.toHaveBeenCalled();
    expect(mocked.list.scrollToEnd).not.toHaveBeenCalled();
  });

  it.each(["onWheel", "onTouchStart", "onPointerDown"])("lets deliberate %s scrolling leave the bottom and load older history", async (event) => {
    const view = await mount();
    await act(async () => { view.surface()[event](); view.list().onScroll(scrolled()); });
    mocked.measuredEnd.mockClear();
    await act(async () => { mocked.resize?.(); });
    expect(mocked.measuredEnd).not.toHaveBeenCalled();
    expect(view.props.chat.loadOlder).toHaveBeenCalledOnce();
  });

  it("stops initial following for a scrolling key, including React Native event shape", async () => {
    const view = await mount();
    await act(async () => { view.surface().onKeyDown({ nativeEvent: { key: "PageUp" } }); view.list().onScroll(scrolled(800)); });
    mocked.measuredEnd.mockClear();
    mocked.resize?.();
    expect(mocked.measuredEnd).not.toHaveBeenCalled();
  });

  it("keeps loading older history when a short list cannot fill the viewport", async () => {
    const view = await mount();
    await act(async () => { view.list().onLayout({ nativeEvent: { layout: { height: 500 } } }); view.list().onContentSizeChange(800, 200); });
    expect(view.props.chat.loadOlder).toHaveBeenCalledOnce();
  });

  it("re-enables bottom following when the reader presses Scroll to bottom", async () => {
    const view = await mount();
    await act(async () => { view.surface().onWheel(); view.list().onScroll(scrolled(800)); });
    const button = root!.root.findByProps({ accessibilityLabel: "Scroll to bottom" });
    await act(async () => { button.props.onPress(); });
    expect(mocked.measuredEnd).toHaveBeenLastCalledWith(mocked.list, true);
    mocked.measuredEnd.mockClear();
    await act(async () => { view.list().onScroll(scrolled(1100)); mocked.resize?.(); });
    expect(mocked.measuredEnd).toHaveBeenCalledOnce();
  });

  it("lets a search reveal override opening follow so later layout cannot hide the result", async () => {
    await mount({ findOpen: true });
    await act(async () => { root!.root.findByType("FindBar" as never).props.onQuery("old prompt"); });
    expect(mocked.list.scrollToIndex).toHaveBeenCalledWith({ index: 0, animated: false, viewPosition: 0.3 });
    mocked.measuredEnd.mockClear();
    mocked.resize?.();
    expect(mocked.measuredEnd).not.toHaveBeenCalled();
  });

  it("lets a saved-message reveal override opening follow", async () => {
    const view = await mount();
    const bookmark = { botId: "bot", hostId: "host", chatId: "chat", rowKey: "e1", role: "user" as const, messageAt: 0, chatTitle: "chat", createdAt: new Date(0).toISOString() };
    const complete = vi.fn();
    await view.update({ chat: { ...view.props.chat, agent: { status: "idle", pendingPermissions: [] } as unknown as NonNullable<ChatState["agent"]> }, revealBookmark: bookmark, onRevealComplete: complete });
    expect(mocked.list.scrollToIndex).toHaveBeenCalledWith({ index: 0, animated: false, viewPosition: 0.3 });
    expect(complete).toHaveBeenCalled();
    mocked.measuredEnd.mockClear();
    mocked.resize?.();
    expect(mocked.measuredEnd).not.toHaveBeenCalled();
  });

  it("leaves inverted native scrolling unchanged and releases the web observer on unmount", async () => {
    const webView = await mount();
    expect(webView.list().inverted).toBe(false);
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(mocked.disconnect).toHaveBeenCalledOnce();
    mocked.measuredEnd.mockClear();
    mocked.resize = null;
    const nativeView = await mount({ platform: "ios" });
    expect(nativeView.list().inverted).toBe(true);
    expect(mocked.resize).toBeNull();
    await act(async () => { nativeView.list().onScroll(scrolled(100)); });
    expect(mocked.measuredEnd).not.toHaveBeenCalled();
  });
});
