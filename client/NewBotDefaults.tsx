import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import type { BotDefaults } from "../shared/bot";
import { useBotHost, useProviders } from "./data";

export function NewBotDefaults({ localHost, defaults, onChange, trailing }: { localHost: { id: string; label: string }; defaults: BotDefaults; onChange(patch: Partial<BotDefaults>): void; trailing?: ReactNode }) {
  const providers = useProviders(useBotHost(null, localHost));
  const provider = providers.data?.find((entry) => entry.provider === defaults.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const thinking = (models.find((model) => model.id === defaults.model) ?? models.find((model) => model.isDefault))?.thinkingOptions ?? [];
  return (
    <SettingsSection title="Defaults for new bots" trailing={trailing} info="The agent a new bot starts with, whether it starts blank, from a role or from a preset. Change it per bot under Model and Permissions.">
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
            {thinking.length ? <SettingsSelect label="Thinking" value={defaults.thinkingOptionId ?? ""} options={[{ label: "Default", value: "" }, ...thinking.map((option) => ({ label: option.label, value: option.id }))]} onValueChange={(value) => onChange({ thinkingOptionId: value || null })} /> : null}
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
