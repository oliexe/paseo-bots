import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { speechChunks } from "../shared/speech";

// Replies read aloud with the device's own voices (the web's speech
// synthesis), one reading at a time: starting another stops the last.
// This plugin typechecks without the DOM library, so declare what's used.

export interface DeviceVoice {
  name: string;
  lang: string;
}
interface Utterance {
  voice: DeviceVoice | null;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
interface Synthesis {
  getVoices(): DeviceVoice[];
  speak(utterance: Utterance): void;
  cancel(): void;
  addEventListener(type: "voiceschanged", listener: () => void): void;
  removeEventListener(type: "voiceschanged", listener: () => void): void;
}
declare const SpeechSynthesisUtterance: new (text: string) => Utterance;

const synth = (globalThis as { speechSynthesis?: Synthesis }).speechSynthesis;

/** Paseo's desktop app can read aloud; its phone apps can't from a plugin. */
export const canSpeak = Platform.OS === "web" && !!synth;

let speaking: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Reads `text` with the named voice (the default one when it isn't on this device). `key` identifies the reading for useSpeaking. */
export function speak(key: string, text: string, voiceName: string | null): void {
  if (!synth) return;
  synth.cancel();
  const voice = voiceName ? synth.getVoices().find((entry) => entry.name === voiceName) : undefined;
  const chunks = speechChunks(text);
  if (chunks.length === 0) return;
  const done = () => {
    if (speaking !== key) return;
    speaking = null;
    changed();
  };
  speaking = key;
  changed();
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.onerror = done;
    if (index === chunks.length - 1) utterance.onend = done;
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  synth?.cancel();
  speaking = null;
  changed();
}

/** Whether the reading `key` is going on. */
export function useSpeaking(key: string): boolean {
  return useSyncExternalStore(subscribe, () => speaking === key);
}

// Voices load late in some browsers; the cached list only changes when they arrive.
const noVoices: DeviceVoice[] = [];
let voicesCache: DeviceVoice[] = noVoices;
const readVoices = () => {
  const voices = synth?.getVoices() ?? [];
  if (voices.length && voices.length !== voicesCache.length) voicesCache = voices;
  return voicesCache;
};
const subscribeVoices = (listener: () => void) => {
  synth?.addEventListener("voiceschanged", listener);
  return () => synth?.removeEventListener("voiceschanged", listener);
};

/** This device's voices in the languages the user reads, or all of them when none match. */
export function useVoices(): DeviceVoice[] {
  const all = useSyncExternalStore(subscribeVoices, readVoices);
  const languages = ((globalThis as { navigator?: { languages?: readonly string[] } }).navigator?.languages ?? []).map((language) => language.split("-")[0]!.toLowerCase());
  const preferred = all.filter((voice) => languages.includes(voice.lang.split(/[-_]/)[0]!.toLowerCase()));
  return (preferred.length ? preferred : all).slice().sort((a, b) => a.name.localeCompare(b.name));
}
