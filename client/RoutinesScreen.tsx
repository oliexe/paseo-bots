import type { PluginOpenScreenInput, PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { EMPTY_LIBRARY, pushHistory, type Bot } from "../shared/bot";
import { mergeRoutineEdits } from "../shared/routine-edit";
import { routineStatusRpc } from "../shared/rpc";
import { AvatarTheme } from "./Avatar";
import { errorText, nativeTokens } from "./native";
import { RoutinesSection } from "./panel/RoutinesSection";
import { MenuProvider } from "./ui/Menu";
import { useBotSettings } from "./useBotSettings";
import { PAGE_STYLE } from "./library/parts";

export function RoutinesScreen(props: PluginScreenProps & { openScreen(input: PluginOpenScreenInput): void }) {
  return <MenuProvider colors={props.theme.colors} compact={props.layout.compact}><AvatarTheme dark={nativeTokens(props.theme.colors).dark}><RoutinesContent {...props} /></AvatarTheme></MenuProvider>;
}

function RoutinesContent({ theme, host, openScreen, params }: PluginScreenProps & { openScreen(input: PluginOpenScreenInput): void }) {
  const colors = theme.colors;
  const { settings, commit } = useBotSettings();
  const inspect = useRpc(routineStatusRpc);
  const status = useQuery({ queryKey: ["paseo-bots", "routines"], queryFn: () => inspect({}), refetchInterval: 15_000 });
  const [selected, setSelected] = useState(params.botId ?? "");
  const [query, setQuery] = useState("");
  const searchInput = useRef<SettingsInputHandle>(null);
  const pending = useRef<Promise<boolean>>(Promise.resolve(true));
  useEffect(() => { setSelected(params.botId ?? ""); setQuery(""); }, [params.botId]);
  useEffect(() => { if (searchInput.current && searchInput.current.getText() !== query) searchInput.current.replaceText(query); }, [query]);
  if (settings.status !== "ready") return <SettingsRow label="Routines" hint={settings.status === "loading" ? "Loading routines…" : undefined} error={settings.status === "loading" ? undefined : "Could not load bot settings."} />;
  const bots = settings.values.bots.filter((bot) => !bot.archived && !bot.hostId);
  const search = query.trim().toLocaleLowerCase();
  const matches = bots.filter((bot) => !search || [bot.name, ...bot.routines.map((routine) => `${routine.name} ${routine.prompt}`)].join(" ").toLocaleLowerCase().includes(search));
  const bot = matches.find((bot) => bot.id === selected) ?? matches[0];
  const routines = bots.flatMap((bot) => bot.routines);
  const routineIds = new Set(routines.map((routine) => routine.id));
  const running = Object.entries(status.data?.routines ?? {}).filter(([id]) => routineIds.has(id)).reduce((sum, [, record]) => sum + record.runs.filter((run) => run.status === "running").length, 0);
  const patch = (patch: Partial<Bot>) => {
    if (!bot) return;
    pending.current = commit((current) => {
      const saved = current.bots.find((entry) => entry.id === bot.id);
      if (!saved) return current;
      const routines = patch.routines ? mergeRoutineEdits(saved.routines, bot.routines, patch.routines) : saved.routines;
      return { ...current, bots: current.bots.map((entry) => entry.id === bot.id ? { ...entry, ...patch, routines, updatedAt: new Date().toISOString() } : entry), history: pushHistory(current.history, saved) };
    });
  };
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={PAGE_STYLE}>
    <SettingsSection title="Bot routines" info={`Scheduled work and webhooks for every bot on ${host.label}.`}>
      <SettingsCard>
        <SettingsRow label="Overview" hint={`${routines.length} routines · ${routines.filter((routine) => routine.enabled).length} enabled · ${running} running`} />
        {status.error || status.data?.error ? <SettingsRow label="Scheduler" error={status.data?.error ?? errorText(status.error)} /> : null}
        <SettingsInput ref={searchInput} label="Find routines" initialValue={query} onChangeText={setQuery} placeholder="Bot name, routine name or prompt" />
        {matches.length ? <SettingsSelect label="Bot" value={bot?.id ?? ""} options={matches.map((entry) => ({ label: `${entry.name} · ${entry.routines.length} ${entry.routines.length === 1 ? "routine" : "routines"}`, value: entry.id }))} onValueChange={setSelected} /> : <SettingsRow label={bots.length ? "No matches" : "No bots"} hint={bots.length ? "No bots or routines match this search." : "Create a bot on this host to give it scheduled work."} />}
      </SettingsCard>
    </SettingsSection>
    {bot ? <RoutinesSection key={bot.id} colors={colors} bot={bot} localHost={host} history={settings.values.history} library={settings.values.library ?? EMPTY_LIBRARY} groups={settings.values.groups ?? []} onPatch={patch} flush={async () => { if (!await pending.current) throw new Error("Could not save the routine. Try again."); }} onRestore={() => {}} onSetup={() => {}} onOpenChat={(chatId) => openScreen({ screenId: "bot-chat", params: { botId: bot.id, chatId, title: bot.name } })} /> : null}
  </ScrollView>;
}
