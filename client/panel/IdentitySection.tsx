import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { randomSeed } from "../../shared/avatar";
import type { BotAvatar, BotVoice } from "../../shared/bot";
import { Avatar } from "../Avatar";
import type { PanelProps } from "./BotPanel";
import { errorText } from "../native";
import { canSpeak, speak, useVoices } from "../speech";
import { canPickFiles } from "../web";
import { AvatarSheet } from "./AvatarSheet";
import { InputField, TextAreaField } from "./controls";
import { ColourRow, pickPicture, PictureSource } from "./picture";

const DESCRIPTION_MAX = 4000;

export function IdentitySection({ colors, bot, onPatch }: PanelProps) {
  const setAvatar = (patch: Partial<BotAvatar>) => onPatch({ avatar: { ...bot.avatar, ...patch } });
  const toast = useToast();
  // An uploaded or generated picture is stored with the bot as a data URL.
  const stored = !!bot.avatar.imageUrl?.startsWith("data:");
  const [generating, setGenerating] = useState(false);
  const [nameEmpty, setNameEmpty] = useState(!bot.name.trim());
  const length = bot.description.length;

  const upload = () =>
    void pickPicture()
      .then((imageUrl) => imageUrl && setAvatar({ imageUrl }))
      .catch((error: unknown) => toast.error(errorText(error)));

  return (
    <>
      <SettingsSection title="Avatar">
        <SettingsCard>
          <SettingsRow label="Picture" hint={stored ? "Your picture" : bot.avatar.imageUrl ? "Showing the image from Image URL" : "A pixel-art face generated for this bot"}>
            <Avatar avatar={bot.avatar} size={56} />
          </SettingsRow>
          <SettingsAction label="New face" hint="Picks a different face" actionLabel="Reroll" onPress={() => setAvatar({ seed: randomSeed(), imageUrl: null })} />
          {canPickFiles ? (
            <>
              <SettingsAction label="Upload a picture" hint="Cropped to a square" actionLabel="Upload" onPress={upload} />
              <SettingsAction label="Generate a picture" hint="Drawn by OpenAI with your key" actionLabel="Generate" onPress={() => setGenerating(true)} />
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
      </SettingsSection>
      {generating ? (
        <AvatarSheet
          colors={colors}
          bot={bot}
          onClose={() => setGenerating(false)}
          onPicture={(imageUrl) => {
            setGenerating(false);
            setAvatar({ imageUrl });
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
