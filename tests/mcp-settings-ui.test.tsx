import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPage } from "../client/library/McpPage";
import { ServerSheet } from "../client/library/McpSheets";
import type { LibraryMcpServer } from "../shared/bot";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => probe }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "SettingsAction", SettingsCard: "SettingsCard", SettingsInput: "SettingsInput", SettingsRow: "SettingsRow", SettingsSection: "SettingsSection", SettingsSwitch: "SettingsSwitch", SettingsSelect: "SettingsSelect", Modal: Object.assign(({ children }: { children: import("react").ReactNode }) => children, { Content: "ModalContent" }),
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("../client/library/McpOAuth", () => ({ McpOAuth: "McpOAuth" }));
vi.mock("../client/library/parts", () => ({ BotsCard: "BotsCard", DangerZone: "DangerZone", PageTitle: "PageTitle" }));
vi.mock("../client/panel/controls", () => ({ Alert: "Alert", Button: "Button", CardNote: "CardNote", SectionLink: "SectionLink", SectionMeta: "SectionMeta", FormTextArea: "FormTextArea", InputField: "InputField", SheetFooter: "SheetFooter", TextAreaField: "TextAreaField" }));
vi.mock("../client/typography", () => ({ code: () => 13, ui: (size: number) => size }));
vi.mock("../client/native", () => ({ errorText: (error: unknown) => error instanceof Error ? error.message : String(error), MONO_FONT: "mono", MONO_PROPS: {} }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial: LibraryMcpServer = { id: "mcp-1", name: "tools", description: "Test server", enabled: false, config: { type: "http", url: "https://example.com/mcp", headers: {}, oauth: true }, tools: null, checkedAt: null, checkError: null, createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z" };
let root: ReactTestRenderer | undefined;
beforeEach(() => { vi.resetAllMocks(); probe.mockResolvedValue({ ok: true, tools: [{ name: "search", description: "Search" }] }); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; });
const control = (label: string) => root!.root.findByProps({ label });
async function press(label: string) { await act(async () => { control(label).props.onPress(); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function page(server = initial) {
  const props = { colors: {} as Parameters<typeof McpPage>[0]["colors"], server, bots: [], otherNames: [], showTitle: false, onPatch: vi.fn(), onToggleBot: vi.fn(), onDelete: vi.fn() };
  await act(async () => { root = create(<McpPage {...props} />); });
  return props;
}

describe("MCP connection settings", () => {
  it("keeps OAuth and custom headers while changing between HTTP and SSE", async () => {
    const onSave = vi.fn();
    await act(async () => { root = create(<ServerSheet colors={{} as never} initial={initial} isNew={false} otherNames={[]} onClose={vi.fn()} onSave={onSave} />); });
    expect(control("Authentication").props.value).toBe("oauth");
    await act(async () => { control("Headers").props.onChangeText("X-Workspace=work"); });
    await act(async () => { control("Transport").props.onValueChange("sse"); });
    await press("Save changes");
    expect(onSave.mock.calls[0][0].config).toEqual({ type: "sse", url: "https://example.com/mcp", headers: { "X-Workspace": "work" }, oauth: true });
    await act(async () => { control("Transport").props.onValueChange("http"); });
    await act(async () => { control("Authentication").props.onValueChange("headers"); });
    await press("Save changes");
    expect(onSave.mock.calls[1][0].config.oauth).toBe(false);
  });

  it("does not offer OAuth for a local command", async () => {
    await act(async () => { root = create(<ServerSheet colors={{} as never} initial={{ ...initial, config: { type: "stdio", command: "npx", args: [], env: {} } }} isNew otherNames={[]} onClose={vi.fn()} onSave={vi.fn()} />); });
    expect(root!.root.findAllByProps({ label: "Authentication" })).toHaveLength(0);
  });

  it("tests the saved server id and enables it only after a successful connection", async () => {
    const props = await page();
    await press("Test and turn on");
    expect(probe).toHaveBeenCalledWith({ config: initial.config, serverId: initial.id });
    expect(props.onPatch).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, tools: [{ name: "search", description: "Search" }], checkError: null }));
  });

  it("lists tools after OAuth connects without enabling an already-saved disabled account on load", async () => {
    const props = await page();
    const oauth = root!.root.findByType("McpOAuth" as never);
    await act(async () => { oauth.props.onConnected(false); });
    expect(props.onPatch.mock.calls[0][0].enabled).toBeUndefined();
    await act(async () => { oauth.props.onConnected(true); });
    expect(props.onPatch.mock.calls[1][0].enabled).toBe(true);
    expect(probe.mock.calls.every(([input]) => input.serverId === "mcp-1")).toBe(true);
  });

  it("does not probe an edited configuration until saved props arrive, or apply an older test result", async () => {
    const pending = deferred<{ ok: true; tools: [] }>();
    probe.mockReturnValueOnce(pending.promise);
    const props = await page();
    await press("Test and turn on");
    await press("Connection");
    const config = { type: "sse" as const, url: "https://new.example/mcp", headers: {}, oauth: true };
    await act(async () => { root!.root.findByType(ServerSheet).props.onSave({ ...initial, config }); });
    expect(probe).toHaveBeenCalledOnce();
    expect(props.onPatch).toHaveBeenCalledWith(expect.objectContaining({ config, enabled: false, tools: null, checkedAt: null }));
    await act(async () => { pending.resolve({ ok: true, tools: [] }); });
    expect(props.onPatch).toHaveBeenCalledOnce();
    await act(async () => { root!.update(<McpPage {...props} server={{ ...initial, config }} />); });
    await press("Test and turn on");
    expect(probe).toHaveBeenLastCalledWith({ serverId: "mcp-1", config });
    expect(props.onPatch).toHaveBeenCalledTimes(2);
  });

  it("ignores a test that finishes after disconnect and clears stale tools", async () => {
    const pending = deferred<{ ok: true; tools: [] }>();
    probe.mockReturnValueOnce(pending.promise);
    const props = await page();
    const test = control("Test and turn on").props.onPress;
    await act(async () => { test(); test(); });
    expect(probe).toHaveBeenCalledOnce();
    await act(async () => { root!.root.findByType("McpOAuth" as never).props.onDisconnected(); });
    await act(async () => { pending.resolve({ ok: true, tools: [] }); });
    expect(props.onPatch).toHaveBeenCalledExactlyOnceWith({ enabled: false, tools: null, checkedAt: null, checkError: null });
  });
});
