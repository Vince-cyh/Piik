import { useEffect, useId, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { PANEL_WORLD } from "../../../shared/room-interactions";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { useCopy } from "../../ui/copy";
import { drawStroke, usePaintSender, usePaintSync } from "./paint-board";
import { PaintPalette } from "./PaintPalette";
import { Btn } from "./primitives";
import { FloatingPanel } from "./FloatingPanel";
import "./room-paint.css";

// The floating board window lives in the "panel" space, independent from the
// stage annotation layer's "stage" space.
const SPACE = "panel";

/** Toggle button + floating board window, opened next to the chat button. */
export function RoomPaintPanel({ session, isHost }: {
  session: RoomInteractionSession | null;
  isHost: boolean;
}) {
  return session ? <ConnectedPaintPanel key={session.key} session={session} isHost={isHost} /> : null;
}

function ConnectedPaintPanel({ session, isHost }: {
  session: RoomInteractionSession;
  isHost: boolean;
}) {
  const { t } = useCopy();
  const { paint, peerId } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const board = paint[SPACE];
  const id = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState(0);
  const [, setStrokeTick] = useState(0);

  const sender = usePaintSender(session, SPACE, () => setStrokeTick(tick => tick + 1));
  usePaintSync(session, SPACE, isHost);

  const redraw = () => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !ctx) return;
    // The canvas is a viewport onto the fixed world: the buffer matches the
    // window, strokes draw in world pixels and simply clip at the edges.
    const box = wrap.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(box.width * dpr));
    const pixelHeight = Math.max(1, Math.round(box.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    const current = session.getSnapshot().paint[SPACE];
    for (const strokeId of current.order) {
      const stroke = current.strokes[strokeId];
      if (stroke) drawStroke(ctx, PANEL_WORLD.width, PANEL_WORLD.height, stroke);
    }
    const live = sender.liveRef.current;
    if (live && peerId) drawStroke(ctx, PANEL_WORLD.width, PANEL_WORLD.height, { by: peerId, color: live.color, points: live.points });
  };

  // Redraw on board changes, panel resize and every local stroke segment.
  useEffect(() => {
    redraw();
  });
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [open]);

  // World coordinates: window pixels map 1:1 onto the fixed world, so strokes
  // never stretch when the window resizes; area beyond the world is off-limits.
  const normalized = (event: PointerEvent<HTMLCanvasElement>): [number, number] | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return null;
    const x = (event.clientX - box.left) / PANEL_WORLD.width;
    const y = (event.clientY - box.top) / PANEL_WORLD.height;
    return x >= 0 && x < 1 && y >= 0 && y < 1 ? [x, y] : null;
  };

  const undo = () => {
    for (let index = board.order.length - 1; index >= 0; index -= 1) {
      const stroke = board.strokes[board.order[index]!];
      if (stroke && stroke.by === peerId) {
        session.sendPaint({ op: "undo", space: SPACE, strokeId: stroke.id });
        return;
      }
    }
  };

  const canUndo = peerId !== null && board.order.some(strokeId => board.strokes[strokeId]?.by === peerId);

  return <>
    <Btn id={`${id}-toggle`} icon="pencil" cap="interaction.paint.open"
      title={open ? "interaction.paint.closePanel" : "interaction.paint.openPanel"}
      hint={open ? "hint-close" : undefined}
      expanded={open} controls={id} popoverTarget={id} tone={open ? "on" : undefined} />
    <FloatingPanel id={id} trigger={`${id}-toggle`} icon="pencil" className="lr-paint-panel"
      title={t("interaction.paint.title")} onOpenChange={setOpen}>
      <div className="lr-paint-panel-tools">
        <PaintPalette color={color} onChange={setColor} />
        <Btn icon="refresh" title="interaction.paint.undo" disabled={!canUndo} onClick={undo} />
        {isHost ? (
          <Btn icon="x" title="interaction.paint.clear" disabled={!board.order.length}
            onClick={() => session.sendPaint({ op: "clear", space: SPACE })} />
        ) : null}
      </div>
      <div className="lr-paint-panel-canvas" ref={wrapRef}>
        <canvas ref={canvasRef}
          onPointerDown={event => {
            const point = normalized(event);
            if (!point || sender.liveRef.current) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            sender.begin(point, color);
          }}
          onPointerMove={event => {
            const point = normalized(event);
            if (point) sender.move(point);
          }}
          onPointerUp={event => {
            sender.end(normalized(event));
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={event => {
            sender.end(normalized(event));
          }} />
      </div>
    </FloatingPanel>
  </>;
}
