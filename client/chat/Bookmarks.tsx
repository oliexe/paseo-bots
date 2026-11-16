import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, useToast } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { bookmarkKey, setMessageBookmark, type MessageBookmark } from "../../shared/bookmarks";
import { errorText } from "../native";
import { useBotSettings } from "../useBotSettings";

type Colors = PluginTheme["colors"];

export function useMessageBookmarks(botId: string, hostId: string, chatId: string | null) {
  const { settings, commit } = useBotSettings();
  const toast = useToast();
  const pending = useRef(new Set<string>());
  const entries = settings.status === "ready" ? settings.values.bookmarks : undefined;
  const bookmarks = useMemo(() => (entries ?? []).filter((entry) => entry.botId === botId && entry.hostId === hostId), [entries, botId, hostId]);
  const savedRows = useMemo(() => new Set(bookmarks.filter((entry) => entry.chatId === chatId).map((entry) => entry.rowKey)), [bookmarks, chatId]);
  const change = async (bookmark: MessageBookmark, saved: boolean) => {
    const key = bookmarkKey(bookmark);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    try {
      const ok = await commit((values) => ({ ...values, bookmarks: setMessageBookmark(values.bookmarks ?? [], bookmark, saved) }));
      if (ok) toast.show(saved ? "Message saved" : "Bookmark removed", { variant: "success" });
    } catch (error) { toast.error(errorText(error)); }
    finally { pending.current.delete(key); }
  };
  return { bookmarks, savedRows, ready: settings.status === "ready", change };
}

export function BookmarksSheet({ botName, bookmarks, onOpen, onRemove, onClose }: { colors: Colors; botName: string; bookmarks: readonly MessageBookmark[]; onOpen(bookmark: MessageBookmark): void; onRemove(bookmark: MessageBookmark): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  useEffect(() => setLimit(50), [query]);
  const search = query.trim().toLocaleLowerCase();
  const shown = bookmarks.filter((entry) => !search || `${entry.chatTitle} ${entry.role === "user" ? "You" : botName}`.toLocaleLowerCase().includes(search));
  return <Modal title={`Saved messages · ${botName}`} open onOpenChange={(open) => !open && onClose()}>
    <Modal.Content>
      <SettingsSection title="Saved messages" info="Bookmarks open the original message in its chat. They sync with this host and stay out of bot and team exports.">
        <SettingsCard>
          {bookmarks.length ? <SettingsInput label="Find saved chats" initialValue={query} onChangeText={setQuery} placeholder="Chat title or author" /> : null}
          {!shown.length ? <SettingsRow label={search ? "No matches" : "No saved messages"} hint={search ? "No saved messages match this search." : "Use the bookmark icon beneath a message to save it here."} /> : null}
          {shown.slice(0, limit).map((entry) => <Fragment key={bookmarkKey(entry)}>
            <SettingsAction label={entry.chatTitle || "Untitled chat"} hint={`${entry.role === "user" ? "Your message" : `${botName}’s reply`} · ${entry.messageAt ? new Date(entry.messageAt).toLocaleString() : `Message ${entry.rowKey.slice(1)}`}`} actionLabel="Open" onPress={() => onOpen(entry)} />
            <SettingsAction label="Bookmark" hint={`Saved from ${entry.chatTitle || "Untitled chat"}`} actionLabel="Remove" onPress={() => onRemove(entry)} />
          </Fragment>)}
          {shown.length > limit ? <SettingsAction label={`${shown.length - limit} more saved messages`} actionLabel="Show more" onPress={() => setLimit((value) => value + 50)} /> : null}
        </SettingsCard>
      </SettingsSection>
    </Modal.Content>
  </Modal>;
}
