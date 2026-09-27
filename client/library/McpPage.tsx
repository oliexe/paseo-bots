import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Bot, LibraryMcpServer } from "../../shared/bot";
import { mcpServerTested, mcpTarget } from "../../shared/library";
import { mcpProbeRpc } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { errorText, MONO_FONT, MONO_PROPS } from "../native";
import { Alert, Button, CardNote, SectionLink, SectionMeta } from "../panel/controls";
import { code, ui } from "../typography";
import { ServerSheet, type McpDraft } from "./McpSheets";
import { BotsCard, DangerZone, PageTitle } from "./parts";

type Colors = PluginTheme["colors"];

interface McpPageProps {
  colors: Colors;
  server: LibraryMcpServer;
  bots: Bot[];
  otherNames: string[];
  showTitle: boolean;
  onPatch(patch: Partial<LibraryMcpServer>): void;
  onToggleBot(bot: Bot, on: boolean): void;
  onDelete(): void;
}

/** Keys only: values are usually secrets. */
function keysHint(server: LibraryMcpServer): string | null {
  const { config } = server;
  const keys = Object.keys(config.type === "stdio" ? config.env : config.headers);
  return keys.length ? `${config.type === "stdio" ? "Environment" : "Headers"}: ${keys.join(", ")}` : null;
}

export function McpPage({ colors, server, bots, otherNames, showTitle, onPatch, onToggleBot, onDelete }: McpPageProps) {
  const probe = useRpc(mcpProbeRpc);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);

  /** Tests the connection; `enable` turns the server on when it connects. */
  const test = async (config = server.config, enable = false) => {
    setTesting(true);
    try {
      const result = await probe({ config });
      const checkedAt = new Date().toISOString();
      onPatch(result.ok ? { tools: result.tools, checkError: null, checkedAt, ...(enable ? { enabled: true } : {}) } : { checkError: result.error, checkedAt });
    } catch (error) {
      onPatch({ checkError: errorText(error), checkedAt: new Date().toISOString() });
    } finally {
      setTesting(false);
    }
  };
  const tested = mcpServerTested(server);

  const tools = server.tools ?? [];
  const toolsMeta = testing ? "Connecting..." : server.checkedAt ? `${server.tools ? `${tools.length} tools · ` : ""}checked ${relativeTime(server.checkedAt)}` : "";

  return (
    <>
      {showTitle ? <PageTitle colors={colors} title={server.name} /> : null}
      {!server.enabled && !tested ? (
        <View style={{ marginBottom: 24, gap: 12 }}>
          <Alert colors={colors} variant="warning" title="Test before bots use it" description="New servers arrive switched off. The test starts it on this host and lists its tools; it turns on once it connects." />
          <View style={{ alignItems: "flex-start" }}>
            <Button colors={colors} variant="outline" icon="PlugZap" label={testing ? "Testing..." : "Test and turn on"} disabled={testing} onPress={() => void test(server.config, true)} />
          </View>
        </View>
      ) : null}
      <SettingsSection title="Server">
        <SettingsCard>
          <SettingsSwitch
            label="Enabled"
            hint={tested ? "When off, no bot gets this server" : "Test it to turn it on"}
            value={server.enabled}
            disabled={testing}
            onValueChange={(enabled) => (enabled && !tested ? void test(server.config, true) : onPatch({ enabled }))}
          />
          <SettingsAction label="Connection" hint={[mcpTarget(server.config), keysHint(server)].filter(Boolean).join("\n")} actionLabel="Edit" onPress={() => setEditing(true)} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Tools"
        info={'Connects the way an agent would and lists what the server offers. Use these names for "Always allowed" in a bot\'s Access settings.'}
        trailing={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {toolsMeta ? <SectionMeta colors={colors} text={toolsMeta} /> : null}
            {testing ? null : <SectionLink colors={colors} icon="RefreshCw" label={server.checkedAt ? "Test again" : "Test connection"} onPress={() => void test()} />}
          </View>
        }
      >
        <SettingsCard>
          {testing ? <CardNote colors={colors} loading text="Starting the server and listing its tools..." /> : null}
          {!testing && server.checkError ? <SettingsRow label="Couldn't connect" error={server.checkError} /> : null}
          {!testing && !server.checkError && server.tools === null ? <CardNote colors={colors} text="Test the connection to see this server's tools" /> : null}
          {!testing && !server.checkError && server.tools?.length === 0 ? <CardNote colors={colors} text="The server lists no tools" /> : null}
          {!testing && !server.checkError
            ? tools.map((tool) => (
                <View key={tool.name} style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 4 }}>
                  <Text selectable numberOfLines={1} {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), color: colors.foreground }}>
                    {server.name}/{tool.name}
                  </Text>
                  {tool.description ? (
                    <Text numberOfLines={2} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
                      {tool.description}
                    </Text>
                  ) : null}
                </View>
              ))
            : null}
        </SettingsCard>
      </SettingsSection>

      <BotsCard colors={colors} bots={bots} noun="server" uses={(bot) => bot.mcpServerIds.includes(server.id)} onToggle={onToggleBot} />

      <DangerZone
        label="Delete server"
        hint="Removes it from the library and from every bot"
        actionLabel="Delete"
        confirmTitle="Delete MCP server?"
        confirmMessage={`Delete "${server.name}"? No bot will get it any more.`}
        onConfirm={onDelete}
      />

      {editing ? (
        <ServerSheet
          colors={colors}
          initial={server}
          isNew={false}
          otherNames={otherNames}
          onClose={() => setEditing(false)}
          onSave={(draft: McpDraft) => {
            setEditing(false);
            const changed = JSON.stringify(draft.config) !== JSON.stringify(server.config);
            // A changed connection makes the old tool list stale; test the new one right away.
            onPatch({ ...draft, ...(changed ? { tools: null, checkError: null, checkedAt: null } : {}) });
            if (changed) void test(draft.config);
          }}
        />
      ) : null}
    </>
  );
}
