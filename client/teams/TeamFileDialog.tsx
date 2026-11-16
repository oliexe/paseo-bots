import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, SettingsAction, SettingsCard, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { Bot, BotGroup } from "../../shared/bot";
import { addImportedBots } from "../../shared/library";
import { exportTeamRpc, importTeamRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { Button, CardNote, FormTextArea, SheetActions } from "../panel/controls";
import { useBotSettings } from "../useBotSettings";

type Colors = PluginTheme["colors"];

export function TeamFileDialog({ colors, onClose }: { colors: Colors; onClose(): void }) {
  const { settings, commit } = useBotSettings();
  return <Modal title="Team file" open onOpenChange={(open) => !open && onClose()}>
    <Modal.Content>
      {settings.status === "ready" ? <TeamFileForm colors={colors} bots={settings.values.bots.filter((bot) => !bot.archived)} groups={settings.values.groups ?? []} commit={commit} /> : <CardNote colors={colors} text={settings.status === "loading" ? "Loading bots…" : "Bot settings can't be read."} loading={settings.status === "loading"} />}
    </Modal.Content>
  </Modal>;
}

/** A team file: every bot that isn't archived and the teams they're on, in one file; and adding those of one. */
function TeamFileForm({ colors, bots, groups, commit }: { colors: Colors; bots: Bot[]; groups: BotGroup[]; commit: ReturnType<typeof useBotSettings>["commit"] }) {
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
