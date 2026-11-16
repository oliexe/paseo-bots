import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { ToolSource } from "../../../shared/tool-results";
import { errorText } from "../../native";

export function SourceCards({ sources }: { colors: PluginTheme["colors"]; sources: ToolSource[] }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? sources : sources.slice(0, 3);
  return <SettingsSection title="Sources"><SettingsCard>
    {shown.map((source) => <SettingsAction key={source.url} label={source.title} hint={[source.domain, source.description].filter(Boolean).join(" · ")} actionLabel="Open" onPress={() => void openExternalUrl(source.url).catch((error) => toast.error(`Couldn't open the source: ${errorText(error)}`))} />)}
    {sources.length > 3 ? <SettingsAction label={`${sources.length} sources`} actionLabel={expanded ? "Show fewer" : "Show all"} onPress={() => setExpanded((value) => !value)} /> : null}
  </SettingsCard></SettingsSection>;
}
