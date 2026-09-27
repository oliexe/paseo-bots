import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { getFileTypeLabel, type ComposerAttachment } from "../shared/attachments";
import { MONO_FONT, MONO_PROPS, nativeTokens } from "./native";
import { code, codeLine, ui } from "./typography";

type Colors = PluginTheme["colors"];

// Paseo's attachment pill (components/attachment-pill.tsx): every body is 48 high inside a
// radius-6 frame with a borderAccent border; images are 48x48 thumbnails, the rest a
// labelled body (18 icon slot with FileText 14, name over the file type) up to 260 wide.
// The remove button sits on the top-left corner and, on desktop, only shows on hover.
const CONTENT_HEIGHT = 48;

interface AttachmentPillProps {
  colors: Colors;
  attachment: ComposerAttachment;
  onRemove?(): void;
  disabled?: boolean;
  /** Paseo always shows the remove button on phones and compact layouts. Defaults to native platforms. */
  alwaysShowRemove?: boolean;
}

export function AttachmentPill({ colors, attachment, onRemove, disabled, alwaysShowRemove }: AttachmentPillProps) {
  const [open, setOpen] = useState(false);
  const [bodyHovered, setBodyHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const showRemove = (alwaysShowRemove ?? Platform.OS !== "web") || bodyHovered || closeHovered;
  const canOpen = attachment.kind !== "file";
  const openLabel = attachment.kind === "image" ? "Open image attachment" : `Open ${attachment.name}`;
  const removeLabel = attachment.kind === "image" ? "Remove image attachment" : "Remove file attachment";

  return (
    <View style={{ position: "relative" }}>
      <Pressable
        accessibilityRole={canOpen ? "button" : undefined}
        accessibilityLabel={canOpen ? openLabel : attachment.name}
        disabled={!canOpen}
        onPress={() => setOpen(true)}
        onHoverIn={() => setBodyHovered(true)}
        onHoverOut={() => setBodyHovered(false)}
        style={frameStyle(colors)}
      >
        {attachment.kind === "image" ? (
          <Image source={{ uri: imageUri(attachment) }} style={{ width: CONTENT_HEIGHT, height: CONTENT_HEIGHT }} />
        ) : (
          <AttachmentLabel colors={colors} icon={<Icon name="FileText" size={14} color={colors.foregroundMuted} />} title={attachment.name} subtitle={subtitleFor(attachment)} />
        )}
      </Pressable>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={removeLabel}
          onPress={onRemove}
          disabled={disabled || !showRemove}
          onHoverIn={() => setCloseHovered(true)}
          onHoverOut={() => setCloseHovered(false)}
          hitSlop={8}
          style={{
            position: "absolute",
            top: -8,
            left: -8,
            width: 24,
            height: 24,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surface2,
            borderWidth: 1,
            borderColor: colors.border,
            zIndex: 1,
            opacity: showRemove ? 1 : 0,
          }}
        >
          <Icon name="X" size={12} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
      {open ? <AttachmentPreview colors={colors} attachment={attachment} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

/** A file still being read or uploaded: Paseo's pending pill with a spinner in the icon slot and no remove button. */
export function PendingAttachmentPill({ colors, name }: { colors: Colors; name: string }) {
  return (
    <View accessibilityLabel={`Attaching ${name}`} style={frameStyle(colors)}>
      <AttachmentLabel colors={colors} icon={<ActivityIndicator size="small" color={colors.foregroundMuted} />} title={name} subtitle={getFileTypeLabel(name) ?? ""} />
    </View>
  );
}

function frameStyle(colors: Colors) {
  return { borderRadius: 6, borderWidth: 1, borderColor: nativeTokens(colors).borderAccent, overflow: "hidden" as const };
}

function imageUri(attachment: Extract<ComposerAttachment, { kind: "image" }>): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

function subtitleFor(attachment: ComposerAttachment): string {
  return getFileTypeLabel(attachment.name) ?? (attachment.kind === "text" ? "TXT" : "");
}

function AttachmentLabel({ colors, icon, title, subtitle }: { colors: Colors; icon: ReactNode; title: string; subtitle: string }) {
  return (
    <View style={{ height: CONTENT_HEIGHT, maxWidth: 260, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, backgroundColor: colors.surface1 }}>
      <View style={{ width: 18, alignItems: "center", justifyContent: "center" }}>{icon}</View>
      <View style={{ minWidth: 0, flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: ui(14), color: colors.foreground }}>
          {title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

/** Paseo's attachment lightbox for images; pasted and attached text opens as a read-only preview. */
function AttachmentPreview({ colors, attachment, onClose }: { colors: Colors; attachment: ComposerAttachment; onClose(): void }) {
  const { height } = useWindowDimensions();
  return (
    <Modal title={attachment.name} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content scrollable={attachment.kind !== "text"}>
        {attachment.kind === "image" ? (
          <Image accessibilityLabel={attachment.name} source={{ uri: imageUri(attachment) }} resizeMode="contain" style={{ width: "100%", height: Math.round(height * 0.6) }} />
        ) : attachment.kind === "text" ? (
          <ScrollView style={{ maxHeight: Math.round(height * 0.6) }}>
            <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
              {attachment.text}
            </Text>
          </ScrollView>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
