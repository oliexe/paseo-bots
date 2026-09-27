import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, useRevealedText } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { ComposerAttachment } from "../../../shared/attachments";
import { capMessageForRender, formatDuration, formatMessageTimestamp, utf8ByteLength } from "../../../shared/markdown";
import { skillProposalId } from "../../../shared/proposals";
import { buildToolCallPresentation, type TaskActivity, type TaskEntry, type ToolCallDetail, type ToolCallStatus } from "../../../shared/tools";
import { AttachmentPill } from "../../AttachmentPill";
import { Markdown } from "../../Markdown";
import { CONTENT_MAX_WIDTH, nativeTokens } from "../../native";
import { content, contentLine, ui } from "../../typography";
import { ToolCallDetailsContent } from "./details";
import type { StreamRow, TurnFooterInfo } from "./model";
import { PlanCard } from "./PlanCard";
import { SkillProposalCard } from "./SkillProposalCard";
import { CopyButton, ExpandableBadge, isWeb, Spinner } from "./ui";

type Colors = PluginTheme["colors"];
type ImageAttachment = Extract<ComposerAttachment, { kind: "image" }>;

/** Paseo's STREAM_METADATA_FONT_SIZE: timestamps, durations and the live timer are a fixed 13. */
export const METADATA_SIZE = 13;
const TIMESTAMP_REVEAL_MS = 3000;

export interface RowContext {
  colors: Colors;
  /** Phone-sized layout: details open in a sheet, controls stay visible. */
  compact: boolean;
  cwd?: string;
  attachmentsFor(row: Extract<StreamRow, { kind: "user" }>): ComposerAttachment[];
}

/** One stream item, laid out like Paseo's StreamItemWrapper (820 wide, 8 inset). */
export function RowFrame({ gapBelow, children }: { gapBelow: number; children: ReactNode }) {
  return <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center", paddingHorizontal: 8, marginBottom: gapBelow }}>{children}</View>;
}

export function RowContent({ row, context, compactBottom }: { row: StreamRow; context: RowContext; compactBottom: boolean }) {
  const { colors } = context;
  switch (row.kind) {
    case "user":
      return <UserMessage colors={colors} compact={context.compact} text={row.text} timestamp={row.timestamp} attachments={context.attachmentsFor(row)} />;
    case "assistant":
      return <AssistantMessage colors={colors} text={row.text} phase={row.phase} compactBottom={compactBottom} />;
    case "thought":
      return <ThoughtRow colors={colors} compact={context.compact} text={row.text} loading={row.loading} />;
    case "tool": {
      const proposalId = skillProposalId(row);
      if (proposalId) return <SkillProposalCard colors={colors} compact={context.compact} proposalId={proposalId} />;
      return <ToolCallRow colors={colors} compact={context.compact} cwd={context.cwd} name={row.name} status={row.status} error={row.error} detail={row.detail} metadata={row.metadata} />;
    }
    case "speak":
      return <SpeakMessage colors={colors} text={row.text} />;
    case "todo":
      return <TodoListCard colors={colors} items={row.items} activity={row.activity} />;
    case "notification":
      return <Notification colors={colors} level={row.level} message={row.message} />;
    case "compaction":
      return <CompactionMarker colors={colors} status={row.status} trigger={row.trigger} preTokens={row.preTokens} />;
  }
}

// ---------------------------------------------------------------- user


const UserMessage = memo(function UserMessage({ colors, compact, text, timestamp, attachments }: { colors: Colors; compact: boolean; text: string; timestamp: number; attachments: ComposerAttachment[] }) {
  const [hovered, setHovered] = useState(false);
  const [lightbox, setLightbox] = useState<ImageAttachment | null>(null);
  const hasText = text.trim().length > 0;
  const images = attachments.filter((attachment): attachment is ImageAttachment => attachment.kind === "image");
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  const showTrailing = hasText && (compact || !isWeb || hovered);
  const getText = useCallback(() => text, [text]);
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", ...(isWeb ? ({ userSelect: "text" } as object) : {}) }}>
      {/* On web a Pressable tracks hover for the timestamp row; phones always show it. */}
      <HoverArea onHover={setHovered} style={{ alignItems: "flex-end", maxWidth: "100%", cursor: "auto" }}>
        <View
          style={{
            backgroundColor: nativeTokens(colors).surface3,
            borderRadius: 16,
            borderTopRightRadius: 2,
            paddingHorizontal: 16,
            paddingVertical: 16,
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {images.length > 0 ? (
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: hasText || files.length > 0 ? 8 : 0 }}>
              {images.map((image) => (
                <Pressable key={image.id} accessibilityRole="button" accessibilityLabel="Open image" onPress={() => setLightbox(image)}>
                  <AttachmentPill colors={colors} attachment={image} />
                </Pressable>
              ))}
            </View>
          ) : null}
          {files.length > 0 ? (
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: hasText ? 8 : 0 }}>
              {files.map((file) => (
                <AttachmentPill key={file.id} colors={colors} attachment={file} />
              ))}
            </View>
          ) : null}
          {hasText ? (
            <Text selectable style={{ color: colors.foreground, fontSize: content(), lineHeight: contentLine(), ...(isWeb ? ({ overflowWrap: "anywhere" } as object) : {}) }}>
              {text}
            </Text>
          ) : null}
        </View>
        {hasText ? (
          <View pointerEvents={showTrailing ? "auto" : "none"} style={{ alignSelf: "flex-end", flexDirection: "row", alignItems: "center", height: 24, gap: 8, marginTop: 8, opacity: showTrailing ? 1 : 0 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: METADATA_SIZE }}>{formatMessageTimestamp(new Date(timestamp))}</Text>
            <CopyButton colors={colors} getContent={getText} label="Copy message" style={{ alignSelf: "center", marginRight: -4 }} />
          </View>
        ) : null}
      </HoverArea>
      {lightbox ? <Lightbox colors={colors} image={lightbox} onClose={() => setLightbox(null)} /> : null}
    </View>
  );
});

function HoverArea({ onHover, style, children }: { onHover(hovered: boolean): void; style: object; children: ReactNode }) {
  if (!isWeb) return <View style={style}>{children}</View>;
  return (
    <Pressable onHoverIn={() => onHover(true)} onHoverOut={() => onHover(false)} style={style}>
      {children}
    </Pressable>
  );
}

/** Paseo's AttachmentLightbox, as the SDK's sheet: the image at its own aspect ratio. */
function Lightbox({ colors, image, onClose }: { colors: Colors; image: ImageAttachment; onClose(): void }) {
  const uri = `data:${image.mimeType};base64,${image.data}`;
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    Image.getSize(
      uri,
      (width, height) => height > 0 && setRatio(width / height),
      () => setRatio(null),
    );
  }, [uri]);
  return (
    <Modal title={image.name} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
        <View style={{ backgroundColor: colors.surface0, alignItems: "center", justifyContent: "center" }}>
          <Image accessibilityLabel={image.name} source={{ uri }} resizeMode="contain" style={ratio ? { width: "100%", aspectRatio: ratio, maxHeight: 720 } : { width: "100%", height: 360 }} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- assistant

const AssistantMessage = memo(function AssistantMessage({ colors, text, phase, compactBottom }: { colors: Colors; text: string; phase: "streaming" | "complete"; compactBottom: boolean }) {
  const capped = useMemo(() => capMessageForRender(text), [text]);
  const revealed = useRevealedText(capped.text, phase);
  const bytes = useMemo(() => (capped.capped && phase === "complete" ? utf8ByteLength(text) : null), [capped.capped, phase, text]);
  return (
    <View style={{ paddingTop: 12, paddingBottom: compactBottom ? 0 : 12, ...(isWeb ? ({ userSelect: "text" } as object) : {}) }}>
      <Markdown colors={colors} text={revealed} streaming={phase === "streaming"} />
      {bytes !== null ? <Text style={{ marginTop: 12, fontSize: ui(14), fontStyle: "italic", color: colors.foregroundMuted }}>This message was capped ({bytes} bytes).</Text> : null}
    </View>
  );
});

const SpeakMessage = memo(function SpeakMessage({ colors, text }: { colors: Colors; text: string }) {
  return (
    <View style={{ paddingVertical: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon name="MicVocal" size={12} color={colors.foregroundMuted} />
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>Spoke</Text>
      </View>
      <Text selectable style={{ fontSize: content(), lineHeight: Math.round(content() * 1.4), color: colors.foreground }}>
        {text}
      </Text>
    </View>
  );
});

// ---------------------------------------------------------------- tool calls

interface ToolCallRowProps {
  colors: Colors;
  compact: boolean;
  cwd?: string;
  name: string;
  status: ToolCallStatus;
  error: unknown;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
  maxDetailHeight?: number;
}

/** Paseo's ToolCall: an expandable badge inline on desktop, a sheet on phones, a plan card for plans. */
export const ToolCallRow = memo(function ToolCallRow({ colors, compact, cwd, name, status, error, detail, metadata, maxDetailHeight = 400 }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState(false);
  const presentation = useMemo(() => buildToolCallPresentation({ name, status, error: error ?? null, detail, metadata, cwd }), [name, status, error, detail, metadata, cwd]);
  const toggle = useCallback(() => (compact ? setSheet(true) : setExpanded((value) => !value)), [compact]);
  const renderDetails = useCallback(
    () => <ToolCallDetailsContent colors={colors} toolName={name} detail={detail} errorText={presentation.errorText} maxHeight={maxDetailHeight} showLoadingSkeleton={presentation.isLoadingDetails} />,
    [colors, name, detail, presentation.errorText, presentation.isLoadingDetails, maxDetailHeight],
  );

  if (presentation.isPlan && detail.type === "plan") return <PlanCard colors={colors} text={detail.text} outcome={presentation.planOutcome} />;

  return (
    <>
      <ExpandableBadge
        colors={colors}
        label={presentation.displayName}
        secondaryLabel={presentation.summary}
        icon={presentation.icon}
        isExpanded={!compact && expanded}
        onToggle={presentation.canOpenDetails ? toggle : undefined}
        renderDetails={presentation.canOpenDetails && !compact ? renderDetails : undefined}
        isLoading={status === "running"}
        isError={status === "failed"}
      />
      {sheet ? (
        <Modal title={presentation.displayName} icon={<Icon name={presentation.icon} size={20} color={colors.foreground} />} open onOpenChange={(open) => !open && setSheet(false)}>
          <Modal.Content style={{ backgroundColor: colors.surface2 }} contentContainerStyle={{ padding: 0, gap: 0, flexGrow: 1 }}>
            <ToolCallDetailsContent colors={colors} toolName={name} detail={detail} errorText={presentation.errorText} fillAvailableHeight showLoadingSkeleton={presentation.isLoadingDetails} />
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
});

/** Reasoning renders as Paseo's "Thinking" tool call, paced like assistant text. */
const ThoughtRow = memo(function ThoughtRow({ colors, compact, text, loading }: { colors: Colors; compact: boolean; text: string; loading: boolean }) {
  const revealed = useRevealedText(text, loading ? "streaming" : "complete");
  const detail = useMemo<ToolCallDetail>(() => ({ type: "unknown", input: revealed, output: null }), [revealed]);
  return <ToolCallRow colors={colors} compact={compact} name="thinking" status={loading ? "running" : "completed"} error={null} detail={detail} />;
});

// ---------------------------------------------------------------- tasks

const ACTIVITY_ICONS: Record<TaskActivity["type"], string> = { created: "SquareCheck", added: "Plus", started: "CircleDot", completed: "Check" };
const ACTIVITY_LABELS: Record<Exclude<TaskActivity["type"], "created">, string> = { added: "Added", started: "Started", completed: "Completed" };

/** Paseo's TodoListCard: one badge per change to the task list, expanding to the list. */
const TodoListCard = memo(function TodoListCard({ colors, items, activity }: { colors: Colors; items: TaskEntry[]; activity: TaskActivity }) {
  const [expanded, setExpanded] = useState(false);
  const label = activity.type === "created" ? `Created ${activity.count} tasks` : ACTIVITY_LABELS[activity.type];
  const secondary = activity.type === "created" ? undefined : activity.task;
  const renderDetails = useCallback(
    () => (
      <View style={{ padding: 8 }}>
        <View style={{ gap: 4 }}>
          {items.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>No tasks yet.</Text>
          ) : (
            items.map((task, index) => <TaskListRow key={task.id ?? `${index}:${task.text}`} colors={colors} task={task} />)
          )}
        </View>
      </View>
    ),
    [colors, items],
  );
  return <ExpandableBadge colors={colors} label={label} secondaryLabel={secondary} icon={ACTIVITY_ICONS[activity.type]} isExpanded={expanded} onToggle={() => setExpanded((value) => !value)} renderDetails={renderDetails} />;
});

/** Paseo's TaskListRow: Circle / CircleDot / CircleCheck 16, finished tasks struck through. */
export function TaskListRow({ colors, task }: { colors: Colors; task: TaskEntry }) {
  const tokens = nativeTokens(colors);
  const completed = task.completed || task.status === "completed";
  const running = !completed && task.status === "in_progress";
  const text = running && task.activeForm ? task.activeForm : task.text;
  return (
    <View accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={completed ? "CircleCheck" : running ? "CircleDot" : "Circle"} size={16} color={running ? tokens.statusDotRunning : tokens.foregroundExtraMuted} />
      <Text
        numberOfLines={1}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          fontSize: ui(14),
          color: completed ? tokens.foregroundExtraMuted : running ? colors.foreground : colors.foregroundMuted,
          ...(completed ? { textDecorationLine: "line-through" as const } : {}),
        }}
      >
        {text}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------- notices

const NOTIFICATION_STYLES = {
  info: { background: "rgba(147, 197, 253, 0.1)", icon: "Info", tint: "#93c5fd" },
  warning: { background: "rgba(245, 158, 11, 0.1)", icon: "TriangleAlert", tint: "#f59e0b" },
  error: { background: "rgba(239, 68, 68, 0.1)", icon: "CircleX", tint: "" },
} as const;

const Notification = memo(function Notification({ colors, level, message }: { colors: Colors; level: "info" | "warning" | "error"; message: string }) {
  const style = NOTIFICATION_STYLES[level];
  return (
    <View style={{ borderRadius: 6, overflow: "hidden", backgroundColor: style.background }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flexShrink: 0, height: 20, justifyContent: "center" }}>
            <Icon name={style.icon} size={16} color={style.tint || colors.statusDanger} />
          </View>
          <View style={{ flex: 1 }}>
            <Text selectable style={{ color: colors.foreground, fontSize: ui(14), lineHeight: 20 }}>
              {message}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
});

function compactionLabel(status: "loading" | "completed", trigger?: "auto" | "manual", preTokens?: number): string {
  if (status === "loading") return "Compacting...";
  if (trigger === "auto") return "Context automatically compacted";
  if (trigger === "manual") return "Context manually compacted";
  if (preTokens) return `Context compacted (${Math.round(preTokens / 1000)}K tokens)`;
  return "Context compacted";
}

const CompactionMarker = memo(function CompactionMarker({ colors, status, trigger, preTokens }: { colors: Colors; status: "loading" | "completed"; trigger?: "auto" | "manual"; preTokens?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 16, gap: 8 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {status === "loading" ? <Spinner color="#a1a1aa" /> : <Icon name="Scissors" size={12} color="#a1a1aa" />}
        <Text style={{ fontSize: METADATA_SIZE, color: colors.foregroundMuted }}>{compactionLabel(status, trigger, preTokens)}</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </View>
  );
});

// ---------------------------------------------------------------- turn footer

/** agent-stream/turn-footer.tsx TurnFooterRow + slot: 13 below the turn, 24 high, 32 below. */
export function TurnFooterRow({ children }: { children: ReactNode }) {
  return (
    <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center", paddingHorizontal: 8, marginTop: 13 }}>
      <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", minHeight: 24, paddingBottom: 32 }}>{children}</View>
    </View>
  );
}

/** Paseo's AssistantTurnFooter: copy, then "Worked for 2m 12s", swapping to the end time on hover or tap. */
export const CompletedTurnFooter = memo(function CompletedTurnFooter({ colors, footer }: { colors: Colors; footer: TurnFooterInfo }) {
  const [hovered, setHovered] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const durationLabel = footer.durationMs !== null ? `Worked for ${formatDuration(footer.durationMs)}` : "";
  const timestampLabel = footer.completedAt !== null ? formatMessageTimestamp(new Date(footer.completedAt)) : "";
  const primary = durationLabel || timestampLabel;
  const canSwap = Boolean(durationLabel && timestampLabel);
  const showTimestamp = canSwap && (isWeb ? hovered : revealed);
  const getContent = useCallback(() => footer.copy, [footer.copy]);
  const press = () => {
    if (isWeb || !canSwap) return;
    if (timer.current) clearTimeout(timer.current);
    setRevealed((value) => !value);
    timer.current = setTimeout(() => {
      setRevealed(false);
      timer.current = null;
    }, TIMESTAMP_REVEAL_MS);
  };
  const labelStyle = { color: colors.foregroundMuted, fontSize: METADATA_SIZE };
  return (
    <TurnFooterRow>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <CopyButton colors={colors} getContent={getContent} style={{ alignSelf: "center", marginLeft: -4 }} />
        {primary ? (
          <Pressable
            onPress={press}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            accessibilityRole={canSwap ? "button" : undefined}
            accessibilityLabel={canSwap ? `${durationLabel}, ended ${timestampLabel}` : primary}
          >
            <View style={{ position: "relative" }}>
              {/* Sizer keeps the width stable while the labels swap. */}
              <Text aria-hidden style={[labelStyle, { opacity: 0 }]}>
                {primary.length >= timestampLabel.length ? primary : timestampLabel}
              </Text>
              <Text style={[labelStyle, { position: "absolute", top: 0, left: 0 }]}>{showTimestamp ? timestampLabel : primary}</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
    </TurnFooterRow>
  );
});

/** turn-footer.tsx WorkingIndicator: a 14pt loader and the live elapsed time of the running turn. */
export function WorkingIndicator({ colors, startedAt }: { colors: Colors; startedAt: string | null | undefined }) {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  return (
    <TurnFooterRow>
      <View style={{ height: 24, flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 12 }}>
        <View style={{ marginLeft: -2 }}>
          <Spinner color={colors.foreground} size={14} />
        </View>
        {Number.isFinite(started) ? <LiveElapsed colors={colors} startedAt={started} /> : null}
      </View>
    </TurnFooterRow>
  );
}

function LiveElapsed({ colors, startedAt }: { colors: Colors; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [startedAt]);
  return <Text style={{ color: colors.foregroundMuted, fontSize: METADATA_SIZE, fontVariant: ["tabular-nums"] }}>{formatDuration(Math.max(0, now - startedAt))}</Text>;
}
