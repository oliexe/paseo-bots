import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, useToast, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { randomSeed } from "../../shared/avatar";
import { avatarStyle, AVATAR_STYLE_OPTIONS } from "../../shared/avatar-options";
import type { Bot, BotAvatar, BotVoice } from "../../shared/bot";
import { Avatar } from "../Avatar";
import type { PanelProps } from "./BotPanel";
import { errorText, nativeTokens } from "../native";
import { canSpeak, speak, useVoices } from "../speech";
import { canPickFiles } from "../web";
import { Button, DrillRow, InputField, SheetActions, TextAreaField } from "./controls";
import { ColourRow, pickPicture, PictureSource } from "./picture";

const DESCRIPTION_MAX = 4000;

export function IdentitySection({ colors, bot, onPatch }: PanelProps) {
  const avatar = useRef(bot.avatar);
  avatar.current = bot.avatar;
  const setAvatar = (patch: Partial<BotAvatar>) => {
    avatar.current = { ...avatar.current, ...patch };
    onPatch({ avatar: avatar.current });
  };
  const [sheet, setSheet] = useState(false);
  const [nameEmpty, setNameEmpty] = useState(!bot.name.trim());
  const length = bot.description.length;

  return (
    <>
      <SettingsSection title="Avatar">
        <SettingsCard>
          <DrillRow colors={colors} label="Picture" hint={pictureHint(bot)} hintLines={2} trailing={<Avatar avatar={bot.avatar} size={40} />} onPress={() => setSheet(true)} />
        </SettingsCard>
      </SettingsSection>
      {sheet ? <AvatarEditor colors={colors} bot={bot} setAvatar={setAvatar} onClose={() => setSheet(false)} /> : null}
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
  return bot.avatar.imageUrl ? "The image from its URL" : AVATAR_STYLE_OPTIONS.find((entry) => entry.value === avatarStyle(bot.avatar.style))!.description;
}

/** Everything about the picture: the face, its colour and shape, or a picture of your own. */
function AvatarEditor({ colors, bot, setAvatar, onClose }: { colors: PanelProps["colors"]; bot: Bot; setAvatar(patch: Partial<BotAvatar>): void; onClose(): void }) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false), mounted = useRef(true);
  const latestSetAvatar = useRef(setAvatar);
  latestSetAvatar.current = setAvatar;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const upload = async () => {
    if (uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    try { const imageUrl = await pickPicture(); if (imageUrl && mounted.current) latestSetAvatar.current({ imageUrl }); }
    catch (error) { if (mounted.current) toast.error(errorText(error)); }
    finally { uploadLock.current = false; if (mounted.current) setUploading(false); }
  };
  return (
    <Modal title="Avatar" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsRow label="Picture" hint={pictureHint(bot)}>
            <Avatar avatar={bot.avatar} size={56} dark={nativeTokens(colors).dark} />
          </SettingsRow>
          <SettingsSelect
            label="Style"
            value={bot.avatar.imageUrl ? "custom" : avatarStyle(bot.avatar.style)}
            options={[...AVATAR_STYLE_OPTIONS.map(({ label, value }) => ({ label, value })), ...(bot.avatar.imageUrl ? [{ label: "Custom picture", value: "custom" }] : [])]}
            onValueChange={(style) => { if (style !== "custom") setAvatar({ style: avatarStyle(style), imageUrl: null }); }}
          />
          <SettingsAction label="New face" hint="Draws a different one" actionLabel="Reroll" onPress={() => setAvatar({ seed: randomSeed(), imageUrl: null })} />
          {canPickFiles ? <SettingsAction label="Upload a picture" hint="Cropped to a square" actionLabel={uploading ? "Loading…" : "Upload"} disabled={uploading} onPress={() => void upload()} /> : null}
          {!bot.avatar.imageUrl ? <>
            <ColourRow colors={colors} value={bot.avatar.palette} onChange={(palette) => setAvatar({ palette })} />
            <AvatarSeed seed={bot.avatar.seed} onChange={(seed) => setAvatar({ seed })} />
          </> : null}
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
          <PictureSource colors={colors} imageUrl={bot.avatar.imageUrl} hint="Optional. Replaces the built-in avatar" placeholder="https://example.com/avatar.png" onChange={(imageUrl) => setAvatar({ imageUrl })} />
        </SettingsCard>
        <SheetActions>
          <Button colors={colors} variant="default" label="Done" onPress={onClose} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

function AvatarSeed({ seed, onChange }: { seed: string; onChange(seed: string): void }) {
  const input = useRef<SettingsInputHandle>(null);
  useEffect(() => { if (input.current?.getText() !== seed) input.current?.replaceText(seed); }, [seed]);
  return <SettingsInput ref={input} label="Seed" hint="The same seed and style always draw the same avatar" initialValue={seed} onChangeText={(text) => {
    const next = text.slice(0, 200);
    if (next !== text) input.current?.replaceText(next);
    onChange(next);
  }} />;
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
