import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { DEFAULT_BOT_DEFAULTS, type Bot, type BotDefaults, type BotGroup } from "../../shared/bot";
import { addImportedBots } from "../../shared/library";
import { exportTeamRpc, importTeamRpc } from "../../shared/rpc";
import { useBotHost, useProviders } from "../data";
import { confirmDialog, errorText } from "../native";
import { Button, CardNote, FormTextArea, SheetActions } from "../panel/controls";
import { useBotSettings } from "../useBotSettings";

type Colors = PluginSurfaceProps["theme"]["colors"];

/** Settings → Plugins → paseo-bots: what new bots start with, saved presets, and team files. */
export function BotsSettings({ theme, host }: PluginSurfaceProps) {
  const colors = theme.colors;
  const { settings, commit } = useBotSettings();
  if (settings.status !== "ready") return <CardNote colors={colors} text={settings.status === "loading" ? "Loading..." : "Bot settings can't be read."} loading={settings.status === "loading"} />;
  const values = settings.values;
  return (
    <>
      <DefaultsSection
        localHost={{ id: host.id, label: host.label }}
        defaults={values.defaults ?? DEFAULT_BOT_DEFAULTS}
        onChange={(patch) => void commit((current) => ({ ...current, defaults: { ...(current.defaults ?? DEFAULT_BOT_DEFAULTS), ...patch } }))}
      />
      <SettingsSection title="Presets" info="Bots you saved with Save as preset in their menu: their identity, instructions, playbooks and skills. They're listed under New bot.">
        <SettingsCard>
          {(values.presets ?? []).length === 0 ? <CardNote colors={colors} text="No presets yet" /> : null}
          {(values.presets ?? []).map((preset) => (
            <SettingsAction
              key={preset.id}
              label={preset.name}
              hint={preset.title || preset.description || undefined}
              actionLabel="Delete"
              onPress={() =>
                void confirmDialog({ title: "Delete preset", message: `Delete the "${preset.name}" preset? Bots made from it stay.`, confirmLabel: "Delete", destructive: true }).then(
                  (confirmed) => confirmed && commit((current) => ({ ...current, presets: (current.presets ?? []).filter((entry) => entry.id !== preset.id) })),
                )
              }
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <TeamSection colors={colors} bots={values.bots.filter((bot) => !bot.archived)} groups={values.groups ?? []} commit={commit} />
    </>
  );
}

function DefaultsSection({ localHost, defaults, onChange }: { localHost: { id: string; label: string }; defaults: BotDefaults; onChange(patch: Partial<BotDefaults>): void }) {
  const providers = useProviders(useBotHost(null, localHost));
  const provider = providers.data?.find((entry) => entry.provider === defaults.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  return (
    <SettingsSection title="Defaults for new bots" info="The agent a new bot starts with, whether it starts blank, from a role or from a preset. Change it per bot under Model and Permissions.">
      <SettingsCard>
        <SettingsSelect
          label="Provider"
          hint={defaults.provider ? undefined : "Claude when it's ready, otherwise the first ready provider"}
          value={defaults.provider}
          options={[{ label: "Automatic", value: "" }, ...(providers.data ?? []).map((entry) => ({ label: (entry.label ?? entry.provider) + (entry.status === "ready" ? "" : ` (${entry.status})`), value: entry.provider }))]}
          onValueChange={(value) => onChange({ provider: value, model: null, modeId: null, thinkingOptionId: null })}
        />
        {provider ? (
          <>
            <SettingsSelect label="Model" value={defaults.model ?? ""} options={[{ label: "Default", value: "" }, ...models.map((entry) => ({ label: entry.label, value: entry.id }))]} onValueChange={(value) => onChange({ model: value || null, thinkingOptionId: null })} />
            <SettingsSelect label="Mode" value={defaults.modeId ?? ""} options={[{ label: "Default", value: "" }, ...(provider.modes ?? []).map((mode) => ({ label: mode.label, value: mode.id }))]} onValueChange={(value) => onChange({ modeId: value || null })} />
          </>
        ) : null}
        <SettingsSelect
          label="Contact other bots"
          value={defaults.contactBots}
          options={[
            { label: "Ask first", value: "ask" },
            { label: "Allowed", value: "allow" },
            { label: "Off", value: "off" },
          ]}
          onValueChange={(contactBots) => onChange({ contactBots })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** A team file: every bot that isn't archived and the teams they're on, in one file; and adding those of one. */
function TeamSection({ colors, bots, groups, commit }: { colors: Colors; bots: Bot[]; groups: BotGroup[]; commit: ReturnType<typeof useBotSettings>["commit"] }) {
  const exportTeam = useRpc(exportTeamRpc);
  const importTeam = useRpc(importTeamRpc);
  const toast = useToast();
  const [includeMemory, setIncludeMemory] = useState(false);
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const copyTeam = async () => {
    setBusy("export");
    try {
      const file = await exportTeam({ bots, groups, includeMemory });
      await copyText(file.json);
      toast.show(`Team file with ${bots.length} ${bots.length === 1 ? "bot" : "bots"} copied`, { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const addTeam = async () => {
    setBusy("import");
    try {
      const imported = await importTeam({ json });
      if (await commit((current) => addImportedBots(current, imported.bots, imported.teams))) {
        setJson("");
        const teams = imported.teams.length ? ` and ${imported.teams.length} ${imported.teams.length === 1 ? "team" : "teams"}` : "";
        toast.show(`Added ${imported.bots.length} ${imported.bots.length === 1 ? "bot" : "bots"}${teams}. Routines arrive paused and skills need a review.`, { variant: "success" });
      }
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title="Team file" info="Share your bots and their teams at once. Chats, keys and each bot's host, folder, tool grants and connected apps stay behind. Imports only add bots and teams; a bot name already in use gets a number.">
      <SettingsCard>
        <SettingsSwitch label="Include memory" hint="MEMORY.md and topic files. Leave off when sharing with someone else." value={includeMemory} onValueChange={setIncludeMemory} />
        <SettingsAction
          label="Copy a team file"
          hint={bots.length ? `${bots.length} ${bots.length === 1 ? "bot" : "bots"}${groups.length ? ` on ${groups.length} ${groups.length === 1 ? "team" : "teams"}` : ""}, all but archived ones` : "No bots to share yet"}
          actionLabel={busy === "export" ? "Copying..." : "Copy"}
          disabled={!bots.length || busy !== null}
          onPress={() => void copyTeam()}
        />
      </SettingsCard>
      <FormTextArea colors={colors} monospace accessibilityLabel="Team file to import" value={json} onChangeText={setJson} autoCapitalize="none" autoCorrect={false} minHeight={120} placeholder='{"format": "paseo-bots-team", …}' />
      <SheetActions>
        <Button colors={colors} variant="default" label={busy === "import" ? "Adding..." : "Add bots"} loading={busy === "import"} disabled={!json.trim() || busy !== null} onPress={() => void addTeam()} />
      </SheetActions>
    </SettingsSection>
  );
}
