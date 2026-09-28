import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import type { Bot } from "../../shared/bot";
import { avatarGenerateRpc, avatarKeyStatusRpc, avatarRemoveKeyRpc, avatarSetKeyRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { squareImage } from "../web";
import { Alert, Button, InputField, SheetActions, TextAreaField } from "./controls";
import { PICTURE_SIZE } from "./picture";

type Colors = PluginTheme["colors"];

const KEY_QUERY = ["paseo-bots", "avatar-key"];

/** Draws an avatar with OpenAI from the bot's name, title and blurb, plus an optional direction. */
export function AvatarSheet({ colors, bot, onClose, onPicture }: { colors: Colors; bot: Bot; onClose(): void; onPicture(imageUrl: string): void }) {
  const status = useRpc(avatarKeyStatusRpc);
  const setKey = useRpc(avatarSetKeyRpc);
  const removeKey = useRpc(avatarRemoveKeyRpc);
  const generate = useRpc(avatarGenerateRpc);
  const queryClient = useQueryClient();
  const key = useQuery({ queryKey: KEY_QUERY, queryFn: () => status({}) });
  const configured = key.data?.configured ?? false;
  const [keyText, setKeyText] = useState("");
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draw = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!configured) {
        await setKey({ key: keyText });
        await queryClient.invalidateQueries({ queryKey: KEY_QUERY });
      }
      const { image } = await generate({ name: bot.name, title: bot.title, description: bot.description, direction });
      onPicture(await squareImage(image, PICTURE_SIZE));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const forgetKey = async () => {
    try {
      await removeKey({});
      await queryClient.invalidateQueries({ queryKey: KEY_QUERY });
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <Modal title="Generate a picture" open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <SettingsSection title="Look" info="Drawn from the bot's name, title and blurb. A direction steers it.">
          <SettingsCard>
            <TextAreaField colors={colors} accessibilityLabel="Direction" value={direction} onChangeText={(text) => setDirection(text.slice(0, 400))} minHeight={96} placeholder="A calm owl librarian in flat colours" />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="OpenAI key" info="OpenAI's image model draws the picture with your key. The key stays on this host.">
          <SettingsCard>
            {configured ? (
              <SettingsAction label="API key" hint={key.data?.keyHint ?? undefined} actionLabel="Remove" disabled={busy} onPress={() => void forgetKey()} />
            ) : (
              <InputField colors={colors} label="API key" monospace secureTextEntry autoCapitalize="none" autoCorrect={false} initialValue="" placeholder="sk-..." onChangeText={setKeyText} />
            )}
          </SettingsCard>
        </SettingsSection>
        {error ? (
          <View style={{ marginBottom: 16 }}>
            <Alert colors={colors} variant="error" title="Couldn't draw it" description={error} />
          </View>
        ) : null}
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Cancel" disabled={busy} onPress={onClose} />
          <Button colors={colors} variant="default" label={busy ? "Drawing..." : "Generate"} loading={busy} disabled={busy || (!configured && !keyText.trim())} onPress={() => void draw()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
