import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgentPermissionResponse } from "../../paseo";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { nativeTokens } from "../../native";
import { ui } from "../../typography";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  isQuestionAnswered,
  parseQuestionFormQuestions,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
  type QuestionFormQuestion,
} from "./question";
import { isWeb, Spinner } from "./ui";

type Colors = PluginTheme["colors"];

interface QuestionFormCardProps {
  colors: Colors;
  input: Record<string, unknown> | undefined;
  compact: boolean;
  isResponding: boolean;
  onRespond(response: PaseoAgentPermissionResponse): void;
}

/** Paseo's QuestionFormCard (components/question-form-card.tsx). */
export function QuestionFormCard({ colors, input, compact, isResponding, onRespond }: QuestionFormCardProps) {
  const tokens = nativeTokens(colors);
  const questions = useMemo(() => parseQuestionFormQuestions(input), [input]);
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [respondingAction, setRespondingAction] = useState<"submit" | "dismiss" | null>(null);
  const [dismissHovered, setDismissHovered] = useState(false);

  if (!questions) return null;

  const index = Math.min(activeIndex, questions.length - 1);
  const question = questions[index]!;
  const allAnswered = areQuestionsAnswered(questions, selections, otherTexts);
  const activeAnswered = isQuestionAnswered(question, index, selections, otherTexts);
  const isLast = index === questions.length - 1;
  const primaryDisabled = isResponding || (isLast ? !allAnswered : !activeAnswered);
  const primaryLabel = isLast ? "Submit" : "Next";
  const dismissLabel = resolveDismissLabel(questions);
  const selected = selections[index] ?? new Set<number>();
  const otherText = otherTexts[index] ?? "";

  const toggle = (optionIndex: number) => {
    const next = new Set(selected);
    if (question.multiSelect) {
      if (next.has(optionIndex)) next.delete(optionIndex);
      else next.add(optionIndex);
    } else if (next.has(optionIndex)) next.clear();
    else {
      next.clear();
      next.add(optionIndex);
    }
    setSelections((previous) => ({ ...previous, [index]: next }));
    // Single-select: an option and a typed answer replace each other.
    if (!question.multiSelect && otherTexts[index]) {
      setOtherTexts((previous) => {
        const copy = { ...previous };
        delete copy[index];
        return copy;
      });
    }
    if (!question.multiSelect && next.size > 0) setActiveIndex(Math.min(index + 1, questions.length - 1));
  };

  const setOther = (text: string) => {
    setOtherTexts((previous) => ({ ...previous, [index]: text }));
    if (!question.multiSelect && text.length > 0 && selected.size > 0) setSelections((previous) => ({ ...previous, [index]: new Set<number>() }));
  };

  const answers = () => ({ ...(input ?? {}), answers: buildQuestionFormAnswers(questions, selections, otherTexts) });

  const submit = () => {
    if (!allAnswered || isResponding) return;
    setRespondingAction("submit");
    onRespond({ behavior: "allow", updatedInput: answers() });
  };

  const dismiss = () => {
    setRespondingAction("dismiss");
    if (shouldSubmitEmptyOnDismiss(questions)) {
      onRespond({ behavior: "allow", updatedInput: answers() });
      return;
    }
    onRespond({ behavior: "deny", message: "Dismissed by user" });
  };

  const primary = () => {
    if (!isLast) {
      if (!activeAnswered || isResponding) return;
      setActiveIndex(Math.min(index + 1, questions.length - 1));
      return;
    }
    submit();
  };

  const placeholder = question.placeholder ?? (question.options.length === 0 ? "Type your answer..." : "Other...");

  return (
    <View style={{ padding: 12, borderRadius: 8, borderWidth: 1, gap: 12, backgroundColor: colors.surface1, borderColor: colors.border }}>
      {questions.length > 1 ? (
        <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingHorizontal: 12 }}>
          {questions.map((entry, entryIndex) => (
            <NavButton
              key={`${entry.header}-${entryIndex}`}
              colors={colors}
              label={entry.header}
              total={questions.length}
              index={entryIndex}
              active={entryIndex === index}
              answered={isQuestionAnswered(entry, entryIndex, selections, otherTexts)}
              disabled={isResponding}
              onPress={() => setActiveIndex(entryIndex)}
            />
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 4 }}>
        <Text style={{ flex: 1, fontSize: ui(14), lineHeight: 22, color: colors.foreground }}>{question.question}</Text>
      </View>
      <View key={question.question} style={{ gap: 8 }}>
        {question.options.length > 0 ? (
          <View style={{ gap: 4 }} {...(!question.multiSelect ? { accessibilityRole: "radiogroup" as const, accessibilityLabel: question.question } : {})}>
            {question.options.map((option, optionIndex) => (
              <OptionRow
                key={`${option.label}-${optionIndex}`}
                colors={colors}
                question={question}
                label={option.label}
                description={option.description}
                selected={selected.has(optionIndex)}
                disabled={isResponding}
                onPress={() => toggle(optionIndex)}
              />
            ))}
          </View>
        ) : null}
        {questionShowsTextInput(question) ? (
          <TextInput
            accessibilityLabel={question.question}
            value={otherText}
            onChangeText={setOther}
            onSubmitEditing={primary}
            placeholder={placeholder}
            placeholderTextColor={colors.foregroundMuted}
            editable={!isResponding}
            blurOnSubmit={false}
            style={{
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 12,
              fontSize: ui(14),
              borderColor: otherText.length > 0 ? tokens.borderAccent : colors.border,
              color: colors.foreground,
              backgroundColor: colors.surface2,
              ...(isWeb ? ({ outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle) : {}),
            }}
          />
        ) : null}
      </View>
      <View style={compact ? { gap: 8 } : { gap: 8, flexDirection: "row", justifyContent: "flex-start", alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          onPress={dismiss}
          disabled={isResponding}
          onHoverIn={() => setDismissHovered(true)}
          onHoverOut={() => setDismissHovered(false)}
          style={({ pressed }) => ({
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 6,
            alignItems: "center",
            borderWidth: 1,
            backgroundColor: dismissHovered ? colors.surface2 : colors.surface1,
            borderColor: tokens.borderAccent,
            opacity: pressed ? 0.9 : 1,
          })}
        >
          {respondingAction === "dismiss" && isResponding ? (
            <Spinner color={colors.foregroundMuted} />
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name="X" size={14} color={colors.foregroundMuted} />
              <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{dismissLabel}</Text>
            </View>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}
          accessibilityState={{ disabled: primaryDisabled }}
          onPress={primary}
          disabled={primaryDisabled}
          style={({ pressed }) => ({
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 6,
            alignItems: "center",
            borderWidth: 1,
            backgroundColor: colors.accent,
            borderColor: colors.accent,
            opacity: primaryDisabled ? 0.5 : pressed ? 0.9 : 1,
          })}
        >
          {respondingAction === "submit" && isResponding ? (
            <Spinner color={colors.accentForeground} />
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name="Check" size={14} color={colors.accentForeground} />
              <Text style={{ fontSize: ui(14), color: colors.accentForeground }}>{primaryLabel}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function NavButton({ colors, label, index, total, active, answered, disabled, onPress }: { colors: Colors; label: string; index: number; total: number; active: boolean; answered: boolean; disabled: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`Question ${index + 1} of ${total}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        minHeight: 28,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        backgroundColor: active || hovered ? colors.surface2 : colors.surface1,
        borderColor: active ? colors.foregroundMuted : colors.border,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {answered ? <Icon name="Check" size={12} color={active ? colors.foreground : colors.foregroundMuted} /> : null}
      <Text numberOfLines={1} style={{ fontSize: ui(14), color: active ? colors.foreground : colors.foregroundMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}

function OptionRow({ colors, question, label, description, selected, disabled, onPress }: { colors: Colors; question: QuestionFormQuestion; label: string; description?: string; selected: boolean; disabled: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const tokens = nativeTokens(colors);
  const multi = question.multiSelect;
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: hovered || selected ? colors.surface2 : "transparent",
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View
          style={{
            width: 18,
            height: 18,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            marginTop: 2,
            borderRadius: multi ? 4 : 999,
            borderColor: selected ? colors.accent : tokens.foregroundExtraMuted,
            backgroundColor: selected && multi ? colors.accent : "transparent",
          }}
        >
          {selected && multi ? <Icon name="Check" size={12} color={colors.accentForeground} /> : null}
          {selected && !multi ? <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: colors.accent }} /> : null}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: ui(14), lineHeight: 22, color: selected ? colors.foreground : colors.foregroundMuted }}>{label}</Text>
          {description ? <Text style={{ fontSize: ui(14), lineHeight: 20, color: colors.foregroundMuted }}>{description}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}
