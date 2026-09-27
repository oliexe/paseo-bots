import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { botLimits, botMcpServers, botSkills, estimateTokens, utf8Bytes, type Bot } from "../../shared/bot";
import { describeSchedule } from "../../shared/routines";
import { systemPromptRpc } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { useBotChats, useBotHost } from "../data";
import { MONO_FONT, MONO_PROPS } from "../native";
import { code, codeLine } from "../typography";
import { useAppsCatalog, useAppsStatus } from "../library/apps";
import type { PanelProps } from "./BotPanel";
import { CardNote, DrillRow, SectionMeta } from "./controls";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// ---------------------------------------------------------------- overview

function size(text: string): string {
  return `${(utf8Bytes(text) / 1000).toFixed(1)} KB · ≈${estimateTokens(text).toLocaleString()} tokens`;
}

export function OverviewSection({ colors, bot, library, localHost, onSetup }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const compose = useRpc(systemPromptRpc);
  const promptBot = useDebounced(bot, 600);
  const prompt = useQuery({
    // The server reads skills from the saved library, so a library change recomposes too.
    queryKey: ["paseo-bots", "prompt", JSON.stringify(promptBot), host.isLocal, JSON.stringify(library.skills)],
    queryFn: () => compose({ bot: promptBot, local: host.isLocal }),
    // Keep the previous composition while edits recompose it, so the card doesn't jump.
    placeholderData: (previous) => previous,
  });
  const [open, setOpen] = useState<{ title: string; text: string } | null>(null);

  const appsStatus = useAppsStatus();
  const appNames = new Map((useAppsCatalog(appsStatus.data?.configured ?? false).data?.apps ?? []).map((app) => [app.slug, app.name]));
  const tools = [
    ...botMcpServers(bot, library).map((server) => server.name),
    ...botSkills(bot, library).map((skill) => `${skill.id} (skill)`),
    ...(appsStatus.data?.configured && host.isLocal ? bot.apps.map((slug) => `${appNames.get(slug) ?? slug} (app)`) : []),
  ];
  const sections = prompt.data?.sections ?? [];

  return (
    <>
      <SettingsSection title="Setup">
        <SettingsCard>
          <SettingsAction label="Set up with the bot" hint="Starts a chat where the bot interviews you and proposes its own instructions and memory" actionLabel="Start" onPress={onSetup} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Summary">
        <SettingsCard>
          <SettingsRow label="Does" hint={bot.title || bot.description || "No title yet. Add one under Identity."} />
          <SettingsRow label="Can reach" hint={tools.length ? tools.join(", ") : "Only its provider's built-in tools and Paseo's tools"} />
          <SettingsRow label="Runs" hint={bot.routines.length ? bot.routines.map((routine) => `${routine.name}: ${describeSchedule(routine.schedule)}${routine.enabled ? "" : " (paused)"}`).join("\n") : "Only when you message it"} />
          <SettingsRow label="Won't" hint={botLimits(bot, { local: host.isLocal, appsConfigured: !!appsStatus.data?.configured }).join("\n")} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title="System prompt"
        info="Sent with every new chat. Open a part to read it."
        trailing={<SectionMeta colors={colors} text={prompt.data ? size(prompt.data.systemPrompt) : "Loading..."} />}
      >
        <SettingsCard>
          {sections.length === 0 ? <CardNote colors={colors} text={prompt.isError ? "Unable to compose the prompt" : "Loading..."} loading={!prompt.isError} /> : null}
          {sections.map((section) => (
            <DrillRow key={section.title} colors={colors} label={section.title} hint={size(section.text)} onPress={() => setOpen(section)} />
          ))}
        </SettingsCard>
      </SettingsSection>
      {open ? (
        <Modal title={open.title} open onOpenChange={(next) => !next && setOpen(null)}>
          <Modal.Content>
            <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
              {open.text}
            </Text>
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- history

function summarize(before: Bot, after: Bot): string {
  const labels: [keyof Bot, string][] = [
    ["name", "name"],
    ["title", "title"],
    ["description", "blurb"],
    ["avatar", "avatar"],
    ["soul", "standing instructions"],
    ["skillIds", "skills"],
    ["routines", "routines"],
    ["playbooks", "playbooks"],
    ["mcpServerIds", "MCP servers"],
    ["apps", "connected apps"],
    ["alwaysAllow", "always-allowed tools"],
    ["contactBots", "contact with other bots"],
    ["cwd", "folder"],
    ["hostId", "host"],
    ["provider", "provider"],
    ["model", "model"],
    ["modeId", "mode"],
    ["thinkingOptionId", "thinking"],
  ];
  const changed = labels.filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(([, label]) => label);
  return changed.length ? `Changed since: ${changed.join(", ")}` : "Same as now";
}

export function HistorySection({ colors, bot, history, onRestore }: PanelProps) {
  const mine = history.filter((entry) => entry.botId === bot.id).reverse();
  return (
    <SettingsSection title="Earlier versions" info="Each burst of edits is kept so you can undo it. Restoring keeps the current version here too.">
      <SettingsCard>
        {mine.length === 0 ? <CardNote colors={colors} text="No earlier versions yet" /> : null}
        {mine.map((entry) => (
          <SettingsAction key={entry.at} label={`Version from ${relativeTime(entry.at)}`} hint={summarize(entry.snapshot, bot)} actionLabel="Restore" onPress={() => onRestore(entry.snapshot)} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------- usage

export function UsageSection({ bot, localHost }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const list = chats.data ?? [];
  const sum = (pick: (usage: NonNullable<(typeof list)[number]["lastUsage"]>) => number | undefined) =>
    list.reduce((total, chat) => total + (chat.lastUsage ? (pick(chat.lastUsage) ?? 0) : 0), 0);
  const input = sum((usage) => usage.inputTokens);
  const output = sum((usage) => usage.outputTokens);
  const cost = sum((usage) => usage.totalCostUsd);
  const working = list.filter((chat) => chat.status === "running").length;
  const loading = chats.isLoading;
  return (
    <SettingsSection title="Usage" info="From each chat's latest turn as reported by the provider. Archived chats aren't counted.">
      <SettingsCard>
        <SettingsRow label="Chats" hint={loading ? "Loading..." : `${list.length} open${working ? `, ${working} working now` : ""}`} />
        <SettingsRow label="Tokens" hint={loading ? "Loading..." : `${input.toLocaleString()} in · ${output.toLocaleString()} out`} />
        <SettingsRow label="Cost" hint={loading ? "Loading..." : cost > 0 ? `$${cost.toFixed(2)}` : "Not reported by this provider"} />
      </SettingsCard>
    </SettingsSection>
  );
}
