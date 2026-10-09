import { useEffect, useRef, useSyncExternalStore } from "react";
import { PAINT_COLORS, type PaintSpace } from "../../../shared/room-interactions";
import { RoomInteractionSession, type PaintStroke } from "../../lib/room-interactions";
import { createOpaqueId } from "../../lib/opaque-id";
import { participantColor } from "./participant-color";

// Batch stroke points; the server paces paint on the same 60ms fast lane.
export const PAINT_SEND_MS = 90;
// Snapshots stay well under the 16KB signaling send gate, not just the 64KB
// read limit: coordinates round to 4 decimals, and only the newest strokes
// that fit the budget are sent.
export const SNAPSHOT_BYTES_BUDGET = 12000;
export const STROKE_WIDTH_PX = 4;

export interface LiveStroke { id: string; color: number; points: [number, number][] }

const resolvedColors = new Map<string, string>();

/** A stroke's palette pick, or the painter's participant color as fallback. */
export function strokeColor(by: string, color: number | undefined): string {
  if (color !== undefined) return PAINT_COLORS[color] ?? PAINT_COLORS[0];
  const cached = resolvedColors.get(by);
  if (cached) return cached;
  const token = participantColor(by);
  const name = /^var\((--[a-z0-9-]+)\)$/i.exec(token)?.[1];
  const value = (name && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || "#ffd54a";
  resolvedColors.set(by, value);
  return value;
}

export function drawStroke(ctx: CanvasRenderingContext2D, width: number, height: number,
  stroke: { by: string; color?: number; points: [number, number][] }) {
  const [first, ...rest] = stroke.points;
  if (!first) return;
  ctx.strokeStyle = strokeColor(stroke.by, stroke.color);
  ctx.lineWidth = STROKE_WIDTH_PX;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(first[0] * width, first[1] * height);
  for (const point of rest) ctx.lineTo(point[0] * width, point[1] * height);
  // A lone tap still leaves a dot.
  if (!rest.length) ctx.lineTo(first[0] * width + 0.01, first[1] * height);
  ctx.stroke();
}

/** Shared stroke capture: batches append ops and tracks the in-flight stroke. */
export function usePaintSender(session: RoomInteractionSession, space: PaintSpace, onChange: () => void) {
  const liveRef = useRef<LiveStroke | null>(null);
  const pendingRef = useRef<[number, number][]>([]);
  const lastSentAtRef = useRef(0);

  const flush = (force: boolean) => {
    const live = liveRef.current;
    const pending = pendingRef.current;
    if (!live || !pending.length) return;
    const now = Date.now();
    if (!force && now - lastSentAtRef.current < PAINT_SEND_MS) return;
    lastSentAtRef.current = now;
    pendingRef.current = [];
    session.sendPaint({ op: "append", space, strokeId: live.id, points: pending });
  };

  return {
    liveRef,
    begin(point: [number, number], color: number) {
      if (liveRef.current) return;
      const id = createOpaqueId();
      liveRef.current = { id, color, points: [point] };
      pendingRef.current = [];
      lastSentAtRef.current = Date.now();
      session.sendPaint({ op: "begin", space, strokeId: id, point, color });
      onChange();
    },
    move(point: [number, number]) {
      const live = liveRef.current;
      if (!live) return;
      live.points.push(point);
      pendingRef.current.push(point);
      flush(false);
      onChange();
    },
    end(point: [number, number] | null) {
      const live = liveRef.current;
      if (!live) return;
      if (point) {
        live.points.push(point);
        pendingRef.current.push(point);
      }
      flush(true);
      session.sendPaint({ op: "end", space, strokeId: live.id });
      liveRef.current = null;
      onChange();
    },
  };
}

/** Late joiners ask the room for this space's board; the host answers with a
 * budgeted snapshot. Works regardless of whether any board UI is visible. */
export function usePaintSync(session: RoomInteractionSession, space: PaintSpace, isHost: boolean) {
  const { ready, paintSyncTick } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const syncAskedRef = useRef(false);

  useEffect(() => {
    if (!ready) syncAskedRef.current = false;
    else if (!isHost && !syncAskedRef.current) {
      syncAskedRef.current = true;
      session.sendPaint({ op: "sync-request", space });
    }
  }, [ready, isHost, session, space]);

  useEffect(() => {
    if (!isHost || paintSyncTick[space] === 0) return;
    const board = session.getSnapshot().paint[space];
    const strokes: PaintStroke[] = [];
    let bytes = 0;
    for (let index = board.order.length - 1; index >= 0; index -= 1) {
      const stroke = board.strokes[board.order[index]!];
      if (!stroke) continue;
      const rounded: PaintStroke = { ...stroke,
        points: stroke.points.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]) };
      bytes += rounded.points.length * 16 + 80;
      if (bytes > SNAPSHOT_BYTES_BUDGET) break;
      strokes.unshift(rounded);
    }
    if (strokes.length) session.sendPaint({ op: "snapshot", space, strokes });
  }, [isHost, paintSyncTick, session, space]);
}
