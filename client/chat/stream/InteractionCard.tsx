import type { PluginTheme } from "@getpaseo/plugin";
import { useComposers, useRpc } from "@getpaseo/plugin/client";
import { copyText, Markdown, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, useToast, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import {
  initialInteractionResponse, InteractionResponseSchema, interactionGetRpc, interactionRespondRpc,
  validateInteractionResponse, type Interaction, type InteractionField, type InteractionResponse,
} from "../../../shared/interaction";
import { errorText } from "../../native";
import { TextAreaField } from "../../panel/controls";
import { useDeviceStorage } from "../composer/storage";
import { appendDraftText } from "../composer/logic";

type Colors = PluginTheme["colors"];
const queryKey = (card: Pick<Interaction, "id" | "agentId">) => ["paseo-bots", "interaction", card.agentId, card.id];

/** Persist edits locally; typing on one device never replaces another device's unfinished answer. */
function useCardDraft(card: Interaction) {
  const storage = useDeviceStorage();
  const [draft, setDraft] = useState(() => card.response ?? initialInteractionResponse(card.spec));
  const touched = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  const key = `@paseo-bots:card:${card.agentId}:${card.id}`;
  useEffect(() => {
    let alive = true;
    void storage.readItem(key).then((raw) => {
      if (!alive || touched.current || card.status !== "pending" || !raw) return;
      try {
        const parsed = InteractionResponseSchema.safeParse(JSON.parse(raw));
        if (parsed.success) setDraft(parsed.data);
      } catch { /* An incomplete local write must not hide the original card. */ }
    }).catch(() => {});
    return () => { alive = false; if (touched.current) void storage.writeItem(key, JSON.stringify(latest.current)).catch(() => {}); };
  }, [key]);
  useEffect(() => {
    if (!touched.current) return;
    const timer = setTimeout(() => void storage.writeItem(key, JSON.stringify(draft)).catch(() => {}), 200);
    return () => clearTimeout(timer);
  }, [key, draft]);
  const edit = (next: InteractionResponse) => { touched.current = true; setDraft(next); };
  return [draft, edit] as const;
}

export function InteractionCard(props: { colors: Colors; compact: boolean; initial: Interaction; onUseDraft?(text: string): void }) {
  return <CardContent key={props.initial.id} {...props} />;
}

function CardContent({ colors, initial, onUseDraft }: { colors: Colors; compact: boolean; initial: Interaction; onUseDraft?(text: string): void }) {
  const nativeComposers = useComposers({ agentId: initial.agentId });
  const get = useRpc(interactionGetRpc);
  const respond = useRpc(interactionRespondRpc);
  const cache = useQueryClient();
  const toast = useToast();
  const [draft, edit] = useCardDraft(initial);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKey(initial),
    queryFn: () => get({ id: initial.id, agentId: initial.agentId }),
    refetchInterval: (state) => {
      if (state.state.data?.interaction === null) return false;
      const status = state.state.data?.interaction?.status ?? initial.status;
      return status === "pending" || status === "submitting" ? 3000 : false;
    },
  });
  const card = query.data?.interaction ?? initial;
  const { spec } = card;
  const settled = card.status === "answered" || card.status === "dismissed";
  const missing = query.isSuccess && query.data.interaction === null;
  const editable = !busy && !settled && card.status !== "submitting" && !missing && query.isSuccess;
  // Dismissing sends no draft text, but its original content remains available
  // to read and copy after the decision.
  const displayed = card.response?.action === "dismiss" ? initialInteractionResponse(spec) : card.response ?? draft;

  const submit = async (response?: InteractionResponse) => {
    if (inFlight.current || settled || missing) return;
    let valid: InteractionResponse | undefined;
    try { valid = response ? validateInteractionResponse(spec, response) : undefined; }
    catch (failure) { setError(errorText(failure)); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await respond({ id: card.id, agentId: card.agentId, ...(valid ? { response: valid } : {}) });
      cache.setQueryData(queryKey(card), result);
    } catch (failure) {
      setError(errorText(failure));
      void query.refetch();
    } finally { inFlight.current = false; setBusy(false); }
  };

  const updateValue = (id: string, value: string) => edit({ ...draft, values: { ...draft.values, [id]: value } });
  const select = (id: string) => {
    if (spec.kind !== "choice") return;
    edit({ ...draft, selected: spec.multiple ? draft.selected.includes(id) ? draft.selected.filter((entry) => entry !== id) : [...draft.selected, id] : [id] });
  };
  const copyDraft = async () => {
    try { await copyText(displayed.text); toast.show("Draft copied", { variant: "success" }); }
    catch (failure) { toast.error(`Couldn't copy the draft: ${errorText(failure)}`); }
  };
  const addToReply = async () => {
    try {
      if (onUseDraft) onUseDraft(displayed.text);
      else {
        const composer = nativeComposers[0];
        if (!composer) return;
        composer.setPrompt(appendDraftText(composer.prompt, displayed.text));
        await composer.focus();
      }
      toast.show("Draft added to your reply", { variant: "success" });
    } catch (failure) { toast.error(`Couldn't open the reply: ${errorText(failure)}`); }
  };

  const status = settled ? card.status === "dismissed" ? "Dismissed" : "Answered" : card.status === "submitting" ? "Sending answer" : "Your input";
  const fields = spec.kind === "form" || spec.kind === "draft" ? spec.fields : [];
  const shownError = settled ? null : card.error ?? error ?? (query.isError ? `Couldn't check this card: ${errorText(query.error)}` : null);

  return (
    <SettingsSection title={spec.title} info={spec.description || undefined}>
      <SettingsCard>
        <SettingsRow label="Status" hint={status} />
        {spec.kind === "confirm" && spec.preview ? <View style={{ padding: 16 }}><Markdown>{spec.preview}</Markdown></View> : null}
        {spec.kind === "choice" ? spec.multiple ? <>
          <SettingsRow label="Choices" hint="Select all that apply." />
          {spec.options.map((option) => <SettingsSwitch key={option.id} label={option.label} hint={option.description} value={displayed.selected.includes(option.id)} disabled={!editable} onValueChange={() => select(option.id)} />)}
        </> : <SettingsSelect label="Choice" hint={spec.options.find((option) => displayed.selected.includes(option.id))?.description} value={displayed.selected[0] ?? ""} options={[{ label: "Choose an option", value: "" }, ...spec.options.map((option) => ({ label: option.label, value: option.id }))]} disabled={!editable} onValueChange={(id) => edit({ ...draft, selected: id ? [id] : [] })} /> : null}
        {fields.map((field) => <CardField key={field.id} colors={colors} field={field} value={displayed.values[field.id] ?? ""} editable={editable} onChange={(value) => updateValue(field.id, value)} />)}
        {spec.kind === "draft" ? <>
          <TextAreaField colors={colors} label="Draft" accessibilityLabel={`${spec.title} draft`} editable={editable} value={displayed.text} maxLength={50_000} onChangeText={(text) => edit({ ...draft, text })} />
          <SettingsAction label="Copy draft" actionLabel="Copy" onPress={() => void copyDraft()} />
          {onUseDraft || nativeComposers.length ? <SettingsAction label="Add to reply" hint="Preserves the text already in your reply" actionLabel="Add" onPress={() => void addToReply()} /> : null}
        </> : null}
        {settled && card.response ? <SettingsRow label="Response" hint={card.status === "dismissed" ? "You dismissed this card. The bot was told not to perform the proposed action." : spec.kind === "confirm" ? `You chose “${spec.actions.find((action) => action.id === card.response?.action)?.label ?? card.response.action}”. Your answer was sent to the bot.` : "Your answer was sent to the bot in this chat."} /> : null}
        {shownError ? <SettingsRow label="Could not send answer" error={shownError} /> : null}
        {missing && !settled ? <SettingsRow label="Card unavailable" hint="Ask the bot for a new one." /> : null}
        {query.isError ? <SettingsAction label="Check card status" actionLabel="Check again" onPress={() => void query.refetch()} /> : null}
        {!settled && !missing ? <>
          <SettingsRow label="Your response" hint={card.status === "submitting" ? "Your answer is saved. Retrying delivers the same answer without changing it." : spec.kind === "draft" ? "Edit the draft before approving. Your bot receives the exact text you approve." : "Your response goes to the bot in this chat."} />
          {card.status === "submitting" ? <SettingsAction label="Deliver saved answer" actionLabel={busy ? "Sending…" : "Retry delivery"} disabled={busy || !query.isSuccess} onPress={() => void submit()} /> : <>
            {spec.kind === "confirm" ? spec.actions.map((action) => <SettingsAction key={action.id} label={action.label} actionLabel={busy ? "Sending…" : action.label} disabled={!editable} onPress={() => void submit({ ...draft, action: action.id })} />) : <SettingsAction label="Send response" actionLabel={busy ? "Sending…" : spec.submitLabel} disabled={!editable} onPress={() => void submit({ ...draft, action: "submit" })} />}
            <SettingsAction label="Dismiss card" actionLabel="Dismiss" disabled={!editable} onPress={() => void submit({ action: "dismiss", values: {}, selected: [], text: "" })} />
          </>}
        </> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function CardField({ colors, field, value, editable, onChange }: { colors: Colors; field: InteractionField; value: string; editable: boolean; onChange(value: string): void }) {
  const input = useRef<SettingsInputHandle>(null);
  useEffect(() => { if (input.current && input.current.getText() !== value) input.current.replaceText(value); }, [value]);
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.kind === "select") return <SettingsSelect label={label} value={value} options={[{ label: field.required ? "Choose an option" : "Not selected", value: "" }, ...field.options.map((option) => ({ label: option, value: option }))]} disabled={!editable} onValueChange={onChange} />;
  if (field.kind === "textarea") return <TextAreaField colors={colors} label={label} editable={editable} value={value} maxLength={8000} placeholder={field.placeholder} onChangeText={onChange} />;
  return <SettingsInput ref={input} label={label} initialValue={value} disabled={!editable} placeholder={field.kind === "date" ? "YYYY-MM-DD" : field.placeholder} onChangeText={onChange} />;
}
