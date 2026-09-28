import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { randomSeed } from "../../shared/avatar";
import type { Bot, BotAvatar, BotVoice } from "../../shared/bot";
import { Avatar } from "../Avatar";
import type { PanelProps } from "./BotPanel";
import { errorText } from "../native";
import { canSpeak, speak, useVoices } from "../speech";
import { canPickFiles } from "../web";
import { AvatarSheet } from "./AvatarSheet";
import { Button, DrillRow, InputField, SheetActions, TextAreaField } from "./controls";
import { ColourRow, pickPicture, PictureSource } from "./picture";

const DESCRIPTION_MAX = 4000;

export function IdentitySection({ colors, bot, onPatch }: PanelProps) {
  const setAvatar = (patch: Partial<BotAvatar>) => onPatch({ avatar: { ...bot.avatar, ...patch } });
  const [sheet, setSheet] = useState<"avatar" | "generate" | null>(null);
  const [nameEmpty, setNameEmpty] = useState(!bot.name.trim());
  const length = bot.description.length;

  return (
    <>
      <SettingsSection title="Avatar">
        <SettingsCard>
          <DrillRow colors={colors} label="Picture" hint={pictureHint(bot)} hintLines={2} trailing={<Avatar avatar={bot.avatar} size={40} />} onPress={() => setSheet("avatar")} />
        </SettingsCard>
      </SettingsSection>
      {sheet === "avatar" ? <AvatarEditor colors={colors} bot={bot} setAvatar={setAvatar} onGenerate={() => setSheet("generate")} onClose={() => setSheet(null)} /> : null}
      {sheet === "generate" ? (
        <AvatarSheet
          colors={colors}
          bot={bot}
          onClose={() => setSheet("avatar")}
          onPicture={(imageUrl) => {
            setAvatar({ imageUrl });
            setSheet("avatar");
          }}
        />
      ) : null}
      <SettingsSection title="Profile">
        <SettingsCard>
          <InputField colors={colors}
            label="Name"
            error={nameEmpty ? "Give the bot a name" : null}
            initialValue={bot.name}
            placeholder="Email Manager"
            onChangeText={(name) => {
              setNameEmpty(!name.trim());
              onPatch({ name: name.replace(/\n/g, " ").slice(0, 100) });
            }}
          />
          <InputField colors={colors}
            label="Title"
            hint="One line: what the bot does"
            initialValue={bot.title}
            placeholder="Describe what your bot does"
            onChangeText={(title) => onPatch({ title: title.replace(/\n/g, " ").slice(0, 200) })}
          />
          <TextAreaField
            colors={colors}
            label="Blurb"
            hint="Who the bot is. Shown in the bot list and given to the agent."
            error={length >= DESCRIPTION_MAX ? `At the ${DESCRIPTION_MAX} character limit` : null}
            defaultValue={bot.description}
            maxLength={DESCRIPTION_MAX}
            onChangeText={(description) => onPatch({ description: description.slice(0, DESCRIPTION_MAX) })}
            placeholder="Triages my inbox every morning and drafts replies in my voice."
          />
        </SettingsCard>
      </SettingsSection>
      {canSpeak ? <VoiceSection bot={bot} onPatch={onPatch} /> : null}
    </>
  );
}

function pictureHint(bot: Bot): string {
  if (bot.avatar.imageUrl?.startsWith("data:")) return "Your picture";
  return bot.avatar.imageUrl ? "The image from its URL" : "A pixel-art face drawn for this bot";
}

/** Everything about the picture: the face, its colour and shape, or a picture of your own. */
function AvatarEditor({ colors, bot, setAvatar, onGenerate, onClose }: { colors: PanelProps["colors"]; bot: Bot; setAvatar(patch: Partial<BotAvatar>): void; onGenerate(): void; onClose(): void }) {
  const toast = useToast();
  const upload = () =>
    void pickPicture()
      .then((imageUrl) => imageUrl && setAvatar({ imageUrl }))
      .catch((error: unknown) => toast.error(errorText(error)));
  return (
    <Modal title="Avatar" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsRow label="Picture" hint={pictureHint(bot)}>
            <Avatar avatar={bot.avatar} size={56} />
          </SettingsRow>
          <SettingsAction label="New face" hint="Draws a different one" actionLabel="Reroll" onPress={() => setAvatar({ seed: randomSeed(), imageUrl: null })} />
          {canPickFiles ? (
            <>
              <SettingsAction label="Upload a picture" hint="Cropped to a square" actionLabel="Upload" onPress={upload} />
              <SettingsAction label="Generate a picture" hint="Drawn by OpenAI with your key" actionLabel="Generate" onPress={onGenerate} />
            </>
          ) : null}
          <ColourRow colors={colors} value={bot.avatar.palette} onChange={(palette) => setAvatar({ palette })} />
          <SettingsSelect
            label="Shape"
            value={bot.avatar.shape}
            options={[
              { label: "Circle", value: "circle" },
              { label: "Rounded", value: "rounded" },
              { label: "Square", value: "square" },
            ]}
            onValueChange={(shape) => setAvatar({ shape })}
          />
          <PictureSource colors={colors} imageUrl={bot.avatar.imageUrl} hint="Optional. Replaces the pixel face" placeholder="https://example.com/avatar.png" onChange={(imageUrl) => setAvatar({ imageUrl })} />
        </SettingsCard>
        <SheetActions>
          <Button colors={colors} variant="default" label="Done" onPress={onClose} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

/** The device voice a bot's replies are read in, and whether finished replies are read out. */
function VoiceSection({ bot, onPatch }: Pick<PanelProps, "bot" | "onPatch">) {
  const voices = useVoices();
  const setVoice = (patch: Partial<BotVoice>) => onPatch({ voice: { ...bot.voice, ...patch } });
  const missing = bot.voice.name !== null && voices.length > 0 && !voices.some((voice) => voice.name === bot.voice.name);
  return (
    <SettingsSection title="Voice" info="Replies are read with this computer's voices. Voices differ between devices; a missing one reads with the default.">
      <SettingsCard>
        <SettingsSelect
          label="Voice"
          hint={missing ? `${bot.voice.name} isn't on this device` : undefined}
          value={bot.voice.name ?? ""}
          options={[{ label: "Default", value: "" }, ...voices.map((voice) => ({ label: voice.name.includes("(") ? voice.name : `${voice.name} (${voice.lang})`, value: voice.name }))]}
          onValueChange={(name) => setVoice({ name: name || null })}
        />
        <SettingsAction label="Hear it" hint="Reads a sentence in this voice" actionLabel="Play" onPress={() => speak(`voice-test:${bot.id}`, `Hi, I'm ${bot.name || "your bot"}.`, bot.voice.name)} />
        <SettingsSwitch label="Read replies aloud" hint="Reads each reply as it finishes, while its chat is open" value={bot.voice.readReplies} onValueChange={(readReplies) => setVoice({ readReplies })} />
      </SettingsCard>
    </SettingsSection>
  );
}
