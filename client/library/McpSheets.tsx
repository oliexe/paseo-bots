import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { formatPairs, joinArgs, MCP_NAME, RESERVED_MCP_NAMES, parseMcpJson, parsePairs, splitArgs, type BotMcpServer, type LibraryMcpServer, type McpServerConfig } from "../../shared/bot";
import { PASEO_MCP_NAME } from "../../shared/paseo-tools";
import { Button, FormTextArea, InputField, SheetFooter, TextAreaField } from "../panel/controls";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];

/** The editable part of a library MCP server. */
export type McpDraft = Pick<LibraryMcpServer, "name" | "description" | "config">;

export const BLANK_SERVER: McpDraft = { name: "", description: "", config: { type: "stdio", command: "", args: [], env: {} } };

const URL_PATTERN = /^https?:\/\/\S+$/i;

interface ServerSheetProps {
  colors: Colors;
  initial: McpDraft;
  isNew: boolean;
  /** Names of the library's other servers; a server name must be unique. */
  otherNames: string[];
  onClose(): void;
  onSave(server: McpDraft): void;
}

/** Adds or edits one MCP server: name, how to start or reach it, and its env vars or headers. */
export function ServerSheet({ colors, initial, isNew, otherNames, onClose, onSave }: ServerSheetProps) {
  const [server, setServer] = useState<McpDraft>(() => JSON.parse(JSON.stringify(initial)) as McpDraft);
  const { config } = server;
  const [pairsText, setPairsText] = useState(() => formatPairs(config.type === "stdio" ? config.env : config.headers));
  const setConfig = (next: McpServerConfig) => setServer({ ...server, config: next });
  const setType = (type: McpServerConfig["type"]) => {
    if (type === config.type) return;
    const next: McpServerConfig =
      type === "stdio" ? { type, command: "", args: [], env: {} } : { type, url: config.type === "stdio" ? "" : config.url, headers: config.type === "stdio" ? {} : config.headers };
    setConfig(next);
    setPairsText(formatPairs(next.type === "stdio" ? next.env : next.headers));
  };

  const name = server.name.trim();
  const nameError = !name
    ? null
    : !MCP_NAME.test(name)
      ? "Use letters, numbers, dashes and underscores"
      : RESERVED_MCP_NAMES.includes(name)
        ? `"${name}" is taken by ${name === PASEO_MCP_NAME ? "Paseo's own tools" : "connected apps"}`
        : otherNames.includes(name)
          ? `"${name}" is already in the library`
          : null;
  const urlError = config.type !== "stdio" && config.url.trim() && !URL_PATTERN.test(config.url.trim()) ? "Use an http:// or https:// URL" : null;
  const complete = !!name && (config.type === "stdio" ? !!config.command.trim() : !!config.url.trim());
  const canSave = complete && !nameError && !urlError;

  return (
    <Modal title={isNew ? "New MCP server" : "Edit MCP server"} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label="Name" hint="Agents see its tools as name/tool" error={nameError} initialValue={server.name} placeholder="gmail" onChangeText={(text) => setServer({ ...server, name: text })} />
            <InputField colors={colors} label="Description" initialValue={server.description} placeholder="What it's for" onChangeText={(description) => setServer({ ...server, description })} />
            <SettingsSelect
              label="Transport"
              value={config.type}
              options={[
                { label: "Local command (stdio)", value: "stdio" },
                { label: "Streamable HTTP", value: "http" },
                { label: "SSE", value: "sse" },
              ]}
              onValueChange={setType}
            />
            {config.type === "stdio" ? (
              <InputField colors={colors} key="command" label="Command" monospace autoCapitalize="none" autoCorrect={false} initialValue={config.command} placeholder="npx" onChangeText={(command) => setConfig({ ...config, command })} />
            ) : (
              <InputField colors={colors} key={`url-${config.type}`} label="URL" error={urlError} initialValue={config.url} placeholder="https://example.com/mcp" onChangeText={(url) => setConfig({ ...config, url: url.trim() })} />
            )}
            {config.type === "stdio" ? (
              <InputField colors={colors}
                key="args"
                label="Arguments"
                monospace
                autoCapitalize="none"
                autoCorrect={false}
                hint="Separated by spaces. Quote arguments that contain spaces."
                initialValue={joinArgs(config.args)}
                placeholder="-y @modelcontextprotocol/server-memory"
                onChangeText={(text) => setConfig({ ...config, args: splitArgs(text) })}
              />
            ) : null}
            <TextAreaField
              key={config.type === "stdio" ? "env" : "headers"}
              colors={colors}
              monospace
              label={config.type === "stdio" ? "Environment" : "Headers"}
              hint="KEY=value, one per line"
              value={pairsText}
              onChangeText={(text) => {
                setPairsText(text);
                const pairs = parsePairs(text);
                setConfig(config.type === "stdio" ? { ...config, env: pairs } : { ...config, headers: pairs });
              }}
              autoCapitalize="none"
              autoCorrect={false}
              minHeight={72}
              placeholder={config.type === "stdio" ? "API_KEY=..." : "Authorization=Bearer ..."}
            />
          </SettingsCard>
        </View>
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" onPress={onClose} style={{ flex: 1 }} />
          <Button
            colors={colors}
            size="md"
            variant="default"
            label={isNew ? "Add server" : "Save changes"}
            disabled={!canSave}
            onPress={() => onSave({ ...server, name, description: server.description.trim() })}
            style={{ flex: 1 }}
          />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

/** Pastes an `{"mcpServers": {...}}` block from Claude Code, Cursor or a .mcp.json file. */
export function ImportSheet({ colors, onClose, onImport }: { colors: Colors; onClose(): void; onImport(servers: BotMcpServer[]): void }) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Paste MCP config" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <SettingsSection title="JSON" info='Paste {"mcpServers": {...}} from Claude Code, Cursor or a .mcp.json file. A name that is already taken gets a number added.'>
          <FormTextArea
            colors={colors}
            monospace
            accessibilityLabel="MCP JSON"
            value={json}
            onChangeText={(text) => {
              setJson(text);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            minHeight={160}
            placeholder='{"mcpServers": {"fetch": {"command": "uvx", "args": ["mcp-server-fetch"]}}}'
          />
          {error ? (
            <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger, marginLeft: 4 }}>
              {error}
            </Text>
          ) : null}
        </SettingsSection>
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" onPress={onClose} style={{ flex: 1 }} />
          <Button
            colors={colors}
            size="md"
            variant="default"
            label="Add servers"
            disabled={!json.trim()}
            onPress={() => {
              try {
                onImport(parseMcpJson(json));
              } catch (caught) {
                setError((caught instanceof Error ? caught.message : String(caught)).replace(/\.$/, ""));
              }
            }}
            style={{ flex: 1 }}
          />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}
