import type { Note, NoteTag } from "./api";

export const TAGS: { id: NoteTag; label: string; key: string; sentence: string; chip: string; dot: string }[] = [
  { id: "timing", label: "Timing", key: "1", sentence: "Timing is off here.", chip: "bg-amber/15 text-amber", dot: "bg-amber" },
  { id: "text", label: "Text", key: "2", sentence: "Fix this text.", chip: "bg-text/15 text-text", dot: "bg-text" },
  { id: "audio", label: "Audio", key: "3", sentence: "Fix the sound here.", chip: "bg-teal/15 text-teal", dot: "bg-teal" },
  { id: "framing", label: "Framing", key: "4", sentence: "Fix the framing.", chip: "bg-lane-picture-text/15 text-lane-picture-text", dot: "bg-lane-picture-text" },
  { id: "remove", label: "Cut", key: "5", sentence: "Cut this.", chip: "bg-red/15 text-red", dot: "bg-red" },
];

export const tagOf = (id?: NoteTag) => TAGS.find((t) => t.id === id);

export const unwritten = (n: Note) => n.status === "draft" && n.kind === "note" && !n.text.trim();

export const sendable = (n: Note) => n.status === "draft" && (n.kind !== "note" || !!(n.text.trim() || n.tag || n.target || n.annotations.length));
