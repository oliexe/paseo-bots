import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { PALETTE_COUNT, paletteSwatch, randomSeed } from "../../shared/avatar";
import type { BotAvatar } from "../../shared/bot";
import { Avatar } from "../Avatar";
import type { PanelProps } from "./BotPanel";
import { errorText } from "../native";
import { canPickFiles, pickFileHandles, squareImage } from "../web";
import { AVATAR_SIZE, AvatarSheet } from "./AvatarSheet";
import { InputField, StackedRow, TextAreaField } from "./controls";

const DESCRIPTION_MAX = 4000;
const IMAGE_URL = /^(https?:\/\/\S+|data:image\/\S+)$/i;

export function IdentitySection({ colors, bot, onPatch }: PanelProps) {
  const setAvatar = (patch: Partial<BotAvatar>) => onPatch({ avatar: { ...bot.avatar, ...patch } });
  const toast = useToast();
  // An uploaded or generated picture is stored with the bot as a data URL.
  const stored = !!bot.avatar.imageUrl?.startsWith("data:");
  const [imageText, setImageText] = useState(stored ? "" : (bot.avatar.imageUrl ?? ""));
  const [generating, setGenerating] = useState(false);
  const [nameEmpty, setNameEmpty] = useState(!bot.name.trim());
  const imageError = imageText.trim() && !IMAGE_URL.test(imageText.trim()) ? "Use an https:// or data:image URL" : null;
  const length = bot.description.length;

  const upload = async () => {
    const [file] = await pickFileHandles({ accept: "image/png,image/jpeg,image/webp,image/gif", multiple: false });
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Pick a picture under 20 MB.");
      setAvatar({ imageUrl: await squareImage(`data:${file.mimeType};base64,${await file.readBase64()}`, AVATAR_SIZE) });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

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
              <SettingsAction label="Upload a picture" hint="Cropped to a square" actionLabel="Upload" onPress={() => void upload()} />
              <SettingsAction label="Generate a picture" hint="Drawn by OpenAI with your key" actionLabel="Generate" onPress={() => setGenerating(true)} />
            </>
          ) : null}
          <StackedRow colors={colors} label="Colour">
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <Swatch colors={colors} label="Automatic colour" color={null} selected={bot.avatar.palette === null} onPress={() => setAvatar({ palette: null })} />
              {Array.from({ length: PALETTE_COUNT }, (_, index) => (
                <Swatch key={index} colors={colors} label={`Colour ${index + 1}`} color={paletteSwatch(index)} selected={bot.avatar.palette === index} onPress={() => setAvatar({ palette: index })} />
              ))}
            </View>
          </StackedRow>
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
          {stored ? (
            <SettingsAction label="Image" hint="Uploaded or generated" actionLabel="Remove" onPress={() => setAvatar({ imageUrl: null })} />
          ) : (
            <InputField colors={colors}
              label="Image URL"
              hint="Optional. Replaces the pixel face"
              error={imageError}
              initialValue={imageText}
              placeholder="https://example.com/avatar.png"
              onChangeText={(url) => {
                setImageText(url);
                const trimmed = url.trim();
                if (!trimmed) setAvatar({ imageUrl: null });
                else if (IMAGE_URL.test(trimmed)) setAvatar({ imageUrl: trimmed });
              }}
            />
          )}
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
    </>
  );
}

/**
 * Paseo's colour swatch (workspace-labels/swatch.tsx): 20pt circle, a 2pt foreground ring drawn
 * inside the box when selected, 12pt hit slop to reach 44pt, radio semantics. The automatic
 * option is an outlined circle.
 */
function Swatch({ colors, label, color, selected, onPress }: { colors: PanelProps["colors"]; label: string; color: string | null; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      hitSlop={12}
      onPress={onPress}
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: color ?? "transparent",
        borderWidth: selected ? 2 : color ? 0 : 1,
        borderColor: selected ? colors.foreground : colors.foregroundMuted,
        borderStyle: color || selected ? "solid" : "dashed",
      }}
    />
  );
}
