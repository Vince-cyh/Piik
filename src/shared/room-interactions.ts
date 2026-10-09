// Room data is transient and bounded. It never describes a media route.
export const MAX_CHAT_CODE_POINTS = 280;
export const INTERACTION_INTERVAL_MS = 800;
export const LASER_INTERVAL_MS = 60;
export const LASER_TRAIL_MS = 1500;
export const LASER_PHASES = ["down", "move", "up"] as const;
export type LaserPhase = typeof LASER_PHASES[number];
// The shared board is a bounded op log of strokes, relayed like chat and the
// laser. Snapshot limits keep one message under the 64KB signal read limit.
export const PAINT_APPEND_POINT_LIMIT = 64;
export const PAINT_STROKE_POINT_LIMIT = 2000;
export const PAINT_SNAPSHOT_STROKE_LIMIT = 200;
export const PAINT_SNAPSHOT_POINT_LIMIT = 8000;
export const PAINT_OPS = ["begin", "append", "end", "undo", "clear", "sync-request", "snapshot"] as const;
export type PaintOp = typeof PAINT_OPS[number];
// Fixed palette keeps strokes legible on the dark stage and the board panel,
// and keeps the wire value a small validated index instead of free text.
export const PAINT_COLORS = [
  "#ff5a5a", "#ffb340", "#ffe066", "#3ddc84", "#38d9a9", "#4aa8ff",
  "#748ffc", "#c07bff", "#ff8fab", "#d4a373", "#adb5bd", "#f5f5f5",
] as const;
// The stage annotation layer and the floating board window are two
// independent boards; every paint op declares which one it belongs to.
export const PAINT_SPACES = ["stage", "panel"] as const;
export type PaintSpace = typeof PAINT_SPACES[number];
export const REACTION_DURATION_MS = 2400;
export const REACTION_IDS = ["wave", "heart", "clap", "laugh", "wow", "party", "fire", "eyes", "star", "sleep", "tomato", "poop"] as const;
export type ReactionId = typeof REACTION_IDS[number];
export const isThrow = (reaction: ReactionId) => reaction === "tomato" || reaction === "poop";
export const REACTION_GLYPHS: Record<ReactionId, string> = {
  wave: "👋", heart: "❤️", clap: "👏", laugh: "😂", wow: "🤯", party: "🎉",
  fire: "🔥", eyes: "👀", star: "⭐", sleep: "😴", tomato: "🍅", poop: "💩",
};

const forbiddenText = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff\uD800-\uDFFF]/u;
export function normalizeChatText(value: string): string | null {
  if (forbiddenText.test(value)) return null;
  const text = value.normalize("NFC").trim();
  return text && Array.from(text).length <= MAX_CHAT_CODE_POINTS ? text : null;
}
