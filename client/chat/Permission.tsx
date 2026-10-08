import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent, PaseoAgentPermissionResponse, PaseoApi } from "../paseo";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { botToolName } from "../../shared/bot-tools";
import { shellCommand } from "../../shared/commands";
import { commandAllowRpc } from "../../shared/rpc";
import { permissionInput, permissionToolName } from "../../shared/tool-name";
import { humanizeToolName, type ToolCallDetail } from "../../shared/tools";
import { errorText } from "../native";
import { ui } from "../typography";
import { ToolCallDetailsContent } from "./stream/details";
import { PlanCard } from "./stream/PlanCard";
import { QuestionFormCard } from "./stream/QuestionForm";
import { CardButton } from "./stream/ui";

type Colors = PluginTheme["colors"];
type Permission = PaseoAgent["pendingPermissions"][number];
type Action = NonNullable<Permission["actions"]>[number];

interface PermissionCardProps {
  colors: Colors;
  permission: Permission;
  api: PaseoApi | null;
  agentId: string | null;
  /** Phones stack the buttons. */
  compact?: boolean;
  /** The bot and folder of the chat, when it can save commands to run without asking (bots on this host). */
  botId?: string;
  cwd?: string | null;
}

/** Paseo's PermissionRequestCard (agent-stream/view.tsx): plan, question and tool requests. */
export function PermissionCard({ colors, permission, api, agentId, compact = false, botId, cwd }: PermissionCardProps) {
  const toast = useToast();
  const allowCommand = useRpc(commandAllowRpc);
  const shell = botId && cwd && permission.kind === "tool" ? shellCommand(permission, cwd) : null;
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const isPlan = permission.kind === "plan";

  useEffect(() => {
    setResponding(false);
    setRespondingId(null);
  }, [permission.id]);

  const respond = async (response: PaseoAgentPermissionResponse) => {
    if (!api || !agentId) return;
    setResponding(true);
    try {
      await api.agents.ref(agentId).respondToPermission({ requestId: permission.id, response });
    } catch (error) {
      setResponding(false);
      setRespondingId(null);
      toast.error(`Couldn't answer: ${errorText(error)}`);
    }
  };

  const actions = useMemo((): Action[] => {
    if (permission.kind === "question") return [];
    if (permission.actions?.length) return permission.actions;
    return [
      { id: "reject", label: "Deny", behavior: "deny", variant: "danger", intent: "dismiss" },
      { id: "accept", label: isPlan ? "Implement" : "Accept", behavior: "allow", variant: "primary" },
    ];
  }, [permission, isPlan]);

  const planText = useMemo(() => {
    const fromMetadata = permission.metadata?.planText;
    if (typeof fromMetadata === "string" && fromMetadata) return fromMetadata;
    const fromInput = permission.input?.plan;
    return typeof fromInput === "string" ? fromInput : undefined;
  }, [permission]);

  const detail = useMemo(
    () => (permission.detail ?? { type: "unknown", input: permission.input ?? null, output: null }) as ToolCallDetail,
    [permission.detail, permission.input],
  );

  if (permission.kind === "question") {
    return <QuestionFormCard colors={colors} input={permission.input} compact={compact} isResponding={responding} onRespond={(response) => void respond(response)} />;
  }

  // OpenMausBot's "Always allow": this exact command in this folder won't ask again for this bot.
  const always = async () => {
    if (!shell || !botId) return;
    setRespondingId("always");
    try {
      await allowCommand({ botId, command: shell.command, cwd: shell.cwd });
    } catch (error) {
      setRespondingId(null);
      toast.error(`Couldn't save the command: ${errorText(error)}`);
      return;
    }
    await respond({ behavior: "allow" });
  };

  const press = (action: Action) => {
    setRespondingId(action.id);
    void respond(action.behavior === "allow" ? { behavior: "allow", selectedActionId: action.id } : { behavior: "deny", selectedActionId: action.id, message: "Denied by user" });
  };

  const title = isPlan ? "Plan" : (permissionTitle(permission) ?? "Permission Required");
  const description = permission.description ?? "";

  const footer = (
    <>
      <Text style={{ fontSize: ui(14), marginVertical: 4, color: colors.foregroundMuted }}>How would you like to proceed?</Text>
      <View style={compact ? { gap: 8 } : { gap: 8, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-start", alignItems: "center", width: "100%" }}>
        {actions.map((action) => (
          <CardButton
            key={action.id}
            colors={colors}
            label={action.label}
            icon={action.behavior === "allow" ? "Check" : "X"}
            primary={action.variant === "primary"}
            busy={responding}
            spinning={responding && respondingId === action.id}
            onPress={() => press(action)}
          />
        ))}
        {shell ? <CardButton colors={colors} label="Always allow" icon="CheckCheck" busy={responding || respondingId === "always"} spinning={respondingId === "always"} onPress={() => void always()} /> : null}
      </View>
    </>
  );

  if (isPlan && planText) {
    return <PlanCard colors={colors} title={title} description={description} text={planText} outcome="pending" footer={footer} disableOuterSpacing />;
  }

  return (
    <View style={{ marginVertical: 12, padding: 12, borderRadius: 8, borderWidth: 1, gap: 8, backgroundColor: colors.surface1, borderColor: colors.border }}>
      <Text style={{ fontSize: ui(14), lineHeight: 22, color: colors.foreground }}>{title}</Text>
      {description ? <Text style={{ fontSize: ui(14), lineHeight: 20, color: colors.foregroundMuted }}>{description}</Text> : null}
      {planText ? <PlanCard colors={colors} title="Proposed plan" text={planText} disableOuterSpacing /> : null}
      {!isPlan ? <ToolCallDetailsContent colors={colors} detail={detail} maxHeight={200} /> : null}
      {footer}
    </View>
  );
}

/** The provider's title, unless it only names a tool with a plainer name: "Ask Helper" for a request to another bot, "Propose changes"… */
function permissionTitle(permission: Permission): string | null {
  if (!permission.name) return permission.title ?? null;
  const name = permissionToolName(permission);
  const readable = readableToolTitle(name, permissionInput(permission));
  return name !== permission.name && readable !== name ? readable : (permission.title ?? readable);
}

function readableToolTitle(name: string, input: Record<string, unknown> | null): string {
  const bot = input?.bot;
  if (botToolName(name) === "ask_bot" && typeof bot === "string" && bot.trim()) return `Ask ${bot.trim()}`;
  return humanizeToolName(name);
}
