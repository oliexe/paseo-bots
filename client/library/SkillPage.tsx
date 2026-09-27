import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { skillNeedsReview, type Bot, type LibrarySkill } from "../../shared/bot";
import { skillImportRpc, skillReadRpc } from "../../shared/rpc";
import { errorText, MONO_FONT, MONO_PROPS } from "../native";
import { Alert, Button, CardNote, SectionLink } from "../panel/controls";
import { code, codeLine } from "../typography";
import { BotsCard, DangerZone, PageTitle } from "./parts";
import { EditSkillSheet, ReviewSkillSheet, type SavedSkill } from "./SkillSheets";

type Colors = PluginTheme["colors"];

interface SkillPageProps {
  colors: Colors;
  skill: LibrarySkill;
  bots: Bot[];
  /** Compact layouts show the name in the back bar instead of a page title. */
  showTitle: boolean;
  onPatch(patch: Partial<LibrarySkill>): void;
  onToggleBot(bot: Bot, on: boolean): void;
  onImported(skills: SavedSkill[]): void;
  onDelete(): void;
}

export const skillQueryKey = (id: string) => ["paseo-bots", "library-skill", id];

/** Imports stored as "github.com/owner/repo/path" update from "owner/repo/path"; links update from themselves. */
function updateSource(source: string): string | null {
  if (source.startsWith("github.com/")) return source.slice("github.com/".length);
  return /^https?:\/\//i.test(source) ? source : null;
}

export function SkillPage({ colors, skill, bots, showTitle, onPatch, onToggleBot, onImported, onDelete }: SkillPageProps) {
  const read = useRpc(skillReadRpc);
  const importSkills = useRpc(skillImportRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const file = useQuery({ queryKey: skillQueryKey(skill.id), queryFn: () => read({ id: skill.id }) });
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const source = updateSource(skill.source);
  const needsReview = skillNeedsReview(skill, file.data?.sha ?? null);
  const changedSinceReview = typeof skill.reviewedSha === "string" && needsReview;

  const update = async () => {
    if (!source) return;
    setUpdating(true);
    try {
      const { skills } = await importSkills({ source });
      onImported(skills);
      await queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
      toast.show("Skill updated", { variant: "success" });
    } catch (error) {
      toast.error(`Couldn't update: ${errorText(error)}`);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <>
      {showTitle ? <PageTitle colors={colors} title={skill.id} /> : null}
      {needsReview && file.data && !file.data.missing ? (
        <View style={{ marginBottom: 24, gap: 12 }}>
          <Alert
            colors={colors}
            variant="warning"
            title={changedSinceReview ? "SKILL.md changed since you reviewed it" : "Review before bots use it"}
            description={changedSinceReview ? "Bots stop using it until you read the new version." : "Skills from outside arrive switched off. Read it, then turn it on."}
          />
          <View style={{ alignItems: "flex-start" }}>
            <Button colors={colors} variant="outline" icon="ScanEye" label="Review" onPress={() => setReviewing(true)} />
          </View>
        </View>
      ) : null}
      <SettingsSection title="Skill">
        <SettingsCard>
          <SettingsSwitch
            label="Enabled"
            hint={needsReview ? "Review it to turn it on" : "When off, no bot gets this skill"}
            value={skill.enabled && !needsReview}
            onValueChange={(enabled) => (enabled && needsReview ? setReviewing(true) : onPatch({ enabled }))}
          />
          {source ? <SettingsAction label="Source" hint={skill.source} actionLabel={updating ? "Updating..." : "Update"} disabled={updating} onPress={() => void update()} /> : null}
        </SettingsCard>
      </SettingsSection>

      <BotsCard colors={colors} bots={bots} noun="skill" uses={(bot) => bot.skillIds.includes(skill.id)} onToggle={onToggleBot} />

      <SettingsSection
        title="SKILL.md"
        info="What a bot reads before a task this skill covers."
        trailing={file.data && !file.data.missing ? <SectionLink colors={colors} icon="Pencil" label="Edit" onPress={() => setEditing(true)} /> : undefined}
      >
        <SettingsCard>
          {file.isLoading ? (
            <View style={{ padding: 16, alignItems: "center" }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            </View>
          ) : file.data?.missing ? (
            <CardNote colors={colors} text={source ? "SKILL.md is missing. Update the skill to fetch it again." : "SKILL.md is missing."} />
          ) : (
            <View style={{ padding: 16 }}>
              <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
                {file.data?.text ?? ""}
              </Text>
            </View>
          )}
        </SettingsCard>
      </SettingsSection>

      <DangerZone
        label="Delete skill"
        hint="Removes it from the library and from every bot"
        actionLabel="Delete"
        confirmTitle="Delete skill?"
        confirmMessage={`Delete "${skill.id}"? Its files are removed and no bot will get it any more.`}
        onConfirm={onDelete}
      />

      {editing && file.data ? (
        <EditSkillSheet
          colors={colors}
          id={skill.id}
          saved={file.data.text}
          onClose={() => setEditing(false)}
          onSaved={(description, sha) => {
            setEditing(false);
            // You wrote it, so it counts as reviewed.
            onPatch({ description, reviewedSha: sha });
            void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
          }}
        />
      ) : null}
      {reviewing && file.data?.sha ? (
        <ReviewSkillSheet
          colors={colors}
          id={skill.id}
          text={file.data.text}
          sha={file.data.sha}
          files={file.data.files}
          onClose={() => setReviewing(false)}
          onApprove={(sha) => {
            setReviewing(false);
            onPatch({ enabled: true, reviewedSha: sha });
          }}
        />
      ) : null}
    </>
  );
}
