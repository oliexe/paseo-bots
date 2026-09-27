import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent, PaseoAgentPermissionResponse, PaseoApi } from "@getpaseo/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ToolCallDetail } from "../../shared/tools";
import { errorText, nativeTokens } from "../native";
import { ui } from "../typography";
import { ToolCallDetailsContent } from "./stream/details";
import { PlanCard } from "./stream/PlanCard";
import { QuestionFormCard } from "./stream/QuestionForm";
import { Spinner } from "./stream/ui";

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
}

/** Paseo's PermissionRequestCard (agent-stream/view.tsx): plan, question and tool requests. */
export function PermissionCard({ colors, permission, api, agentId, compact = false }: PermissionCardProps) {
  const toast = useToast();
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

  const press = (action: Action) => {
    setRespondingId(action.id);
    void respond(action.behavior === "allow" ? { behavior: "allow", selectedActionId: action.id } : { behavior: "deny", selectedActionId: action.id, message: "Denied by user" });
  };

  const title = isPlan ? "Plan" : (permission.title ?? permission.name ?? "Permission Required");
  const description = permission.description ?? "";

  const footer = (
    <>
      <Text style={{ fontSize: ui(14), marginVertical: 4, color: colors.foregroundMuted }}>How would you like to proceed?</Text>
      <View style={compact ? { gap: 8 } : { gap: 8, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-start", alignItems: "center", width: "100%" }}>
        {actions.map((action) => (
          <ActionButton key={action.id} colors={colors} action={action} busy={responding} spinning={responding && respondingId === action.id} onPress={() => press(action)} />
        ))}
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

function ActionButton({ colors, action, busy, spinning, onPress }: { colors: Colors; action: Action; busy: boolean; spinning: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const primary = action.variant === "primary";
  const tint = primary ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      disabled={busy}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 6,
        alignItems: "center",
        borderWidth: 1,
        backgroundColor: hovered ? colors.surface2 : colors.surface1,
        borderColor: nativeTokens(colors).borderAccent,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {spinning ? (
        <Spinner color={tint} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={action.behavior === "allow" ? "Check" : "X"} size={14} color={tint} />
          <Text style={{ fontSize: ui(14), color: tint }}>{action.label}</Text>
        </View>
      )}
    </Pressable>
  );
}
