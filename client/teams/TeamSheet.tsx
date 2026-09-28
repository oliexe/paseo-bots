import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { randomSeed } from "../../shared/avatar";
import type { Bot, BotGroup, TeamLogo as Logo } from "../../shared/bot";
import { teamLogoOf, teamOf, type TeamDraft } from "../../shared/groups";
import { TeamLogo } from "../Avatar";
import { errorText, nativeTokens } from "../native";
import { Button, InputField, SheetActions, TextAreaField } from "../panel/controls";
import { ColourRow, pickPicture, PictureSource } from "../panel/picture";
import { canPickFiles } from "../web";

type Colors = PluginTheme["colors"];

/**
 * A team's name, logo, members, Chief of Staff and shared instructions, as
 * OpenMausBot's team settings. A bot is on one team at most: adding it here
 * takes it off its other team.
 */
export function TeamSheet({
  colors,
  group,
  groups,
  bots,
  onClose,
  onSave,
  onDelete,
}: {
  colors: Colors;
  /** Null for a new team. */
  group: BotGroup | null;
  groups: readonly BotGroup[];
  bots: readonly Bot[];
  onClose(): void;
  onSave(team: TeamDraft): void;
  onDelete?: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? "");
  const [logo, setLogo] = useState<Logo>(() => (group ? teamLogoOf(group) : { seed: randomSeed(), palette: null, imageUrl: null }));
  const [memberIds, setMemberIds] = useState<string[]>(group ? [...new Set([...(group.leadId ? [group.leadId] : []), ...group.memberIds])] : []);
  const [leadId, setLeadId] = useState<string | null>(group?.leadId ?? null);
  const [instructions, setInstructions] = useState(group?.instructions ?? "");
  const live = bots.filter((bot) => !bot.archived);
  const members = live.filter((bot) => memberIds.includes(bot.id));
  const lead = leadId && memberIds.includes(leadId) ? leadId : null;

  const toggle = (botId: string, on: boolean) => setMemberIds((current) => (on ? [...current, botId] : current.filter((id) => id !== botId)));
  const patchLogo = (patch: Partial<Logo>) => setLogo((current) => ({ ...current, ...patch }));
  const upload = () =>
    void pickPicture()
      .then((imageUrl) => imageUrl && patchLogo({ imageUrl }))
      .catch((error: unknown) => toast.error(errorText(error)));

  return (
    <Modal title={group ? "Edit team" : "New team"} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label="Name" initialValue={name} placeholder="Operations" onChangeText={setName} />
          </SettingsCard>
        </View>
        <SettingsSection title="Logo">
          <SettingsCard>
            <SettingsRow label="Picture" hint={logo.imageUrl?.startsWith("data:") ? "Your picture" : logo.imageUrl ? "Showing the image from Image URL" : "Pixel art drawn for this team"}>
              <TeamLogo group={{ id: group?.id ?? "", logo }} size={56} dark={nativeTokens(colors).dark} />
            </SettingsRow>
            <SettingsAction label="New logo" hint="Draws a different one" actionLabel="Reroll" onPress={() => patchLogo({ seed: randomSeed(), imageUrl: null })} />
            {canPickFiles ? <SettingsAction label="Upload a picture" hint="Cropped to a square" actionLabel="Upload" onPress={upload} /> : null}
            <ColourRow colors={colors} value={logo.palette} onChange={(palette) => patchLogo({ palette })} />
            <PictureSource colors={colors} imageUrl={logo.imageUrl} hint="Optional. Replaces the pixel logo" placeholder="https://example.com/logo.png" onChange={(imageUrl) => patchLogo({ imageUrl })} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Members" info="Every member gets the roster and the shared instructions in its prompt. A bot can be on one team at a time.">
          <SettingsCard>
            {live.map((bot) => {
              const other = teamOf(bot.id, groups);
              const elsewhere = other && other.id !== group?.id ? other : null;
              return (
                <SettingsSwitch
                  key={bot.id}
                  label={bot.name}
                  hint={elsewhere ? `On ${elsewhere.name || "another team"}; adding moves it here` : bot.title || undefined}
                  value={memberIds.includes(bot.id)}
                  onValueChange={(on) => toggle(bot.id, on)}
                />
              );
            })}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Chief of Staff" info="Your main contact for the team. It decides what to handle itself and asks teammates for the rest.">
          <SettingsCard>
            <SettingsSelect
              label="Lead"
              value={lead ?? ""}
              disabled={members.length === 0}
              options={[{ label: "None", value: "" }, ...members.map((bot) => ({ label: bot.name, value: bot.id }))]}
              onValueChange={(value) => setLeadId(value || null)}
            />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Shared instructions" info="Added to every member's prompt. Only you edit them.">
          <SettingsCard>
            <TextAreaField colors={colors} accessibilityLabel="Shared instructions" value={instructions} onChangeText={setInstructions} minHeight={160} placeholder="We handle the family's paperwork. Keep anything with an account number out of replies." />
          </SettingsCard>
        </SettingsSection>
        <SheetActions leading={onDelete ? <Button colors={colors} variant="ghost" label="Delete team" icon="Trash2" onPress={onDelete} /> : null}>
          <Button colors={colors} variant="ghost" label="Cancel" onPress={onClose} />
          <Button
            colors={colors}
            variant="default"
            label={group ? "Save" : "Create team"}
            disabled={!name.trim()}
            onPress={() => onSave({ name: name.trim().slice(0, 60), logo, leadId: lead, memberIds: members.map((bot) => bot.id), instructions })}
          />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
