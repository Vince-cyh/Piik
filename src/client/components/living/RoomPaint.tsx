import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type RefObject } from "react";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { drawStroke, usePaintSender, usePaintSync } from "./paint-board";
import { PaintPalette } from "./PaintPalette";
import { Btn } from "./primitives";
import "./room-paint.css";

// Stage annotations live in the "stage" space, independent from the floating
// board window's "panel" space.
const SPACE = "stage";

interface ContentRect { x: number; y: number; w: number; h: number }

export function RoomPaint({ session, videoRef, active, isHost }: {
  session: RoomInteractionSession | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  active: boolean;
  isHost: boolean;
}) {
  return session && active ? <ConnectedPaint key={session.key} session={session} videoRef={videoRef} isHost={isHost} /> : null;
}

function ConnectedPaint({ session, videoRef, isHost }: {
  session: RoomInteractionSession;
  videoRef: RefObject<HTMLVideoElement | null>;
  isHost: boolean;
}) {
  const { paint, peerId } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const board = paint[SPACE];
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rect, setRect] = useState<ContentRect | null>(null);
  const [paintOn, setPaintOn] = useState(false);
  const [color, setColor] = useState(0);
  const [, setStrokeTick] = useState(0);

  const sender = usePaintSender(session, SPACE, () => setStrokeTick(tick => tick + 1));
  usePaintSync(session, SPACE, isHost);

  // object-fit: contain letterboxes the picture; strokes travel normalized to
  // the picture, so both sides map through the same content rect.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const video = videoRef.current;
      const box = root.getBoundingClientRect();
      const width = video?.videoWidth ?? 0;
      const height = video?.videoHeight ?? 0;
      if (!width || !height || box.width < 2 || box.height < 2) {
        setRect(null);
        return;
      }
      const scale = Math.min(box.width / width, box.height / height);
      const w = width * scale;
      const h = height * scale;
      setRect({ x: (box.width - w) / 2, y: (box.height - h) / 2, w, h });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const video = videoRef.current;
    video?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      video?.removeEventListener("resize", measure);
    };
  }, [videoRef]);

  const redraw = (area: ContentRect) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(area.w * dpr));
    const pixelHeight = Math.max(1, Math.round(area.h * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, area.w, area.h);
    const current = session.getSnapshot().paint[SPACE];
    for (const id of current.order) {
      const stroke = current.strokes[id];
      if (stroke) drawStroke(ctx, area.w, area.h, stroke);
    }
    // The in-flight stroke renders ahead of its server echo.
    const live = sender.liveRef.current;
    if (live && peerId) drawStroke(ctx, area.w, area.h, { by: peerId, color: live.color, points: live.points });
  };

  useEffect(() => {
    if (rect) redraw(rect);
  });

  const normalized = (event: PointerEvent<HTMLDivElement>): [number, number] | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return null;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const point = normalized(event);
    if (!point || sender.liveRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    sender.begin(point, color);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    sender.end(normalized(event));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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

  const rectStyle = (area: ContentRect): CSSProperties => ({
    left: area.x, top: area.y, width: area.w, height: area.h,
  });
  const canUndo = peerId !== null && board.order.some(id => board.strokes[id]?.by === peerId);

  return (
    <div className="lr-paint" ref={rootRef}>
      {rect && paintOn ? (
        <div className="lr-paint-capture" style={rectStyle(rect)}
          onPointerDown={onPointerDown} onPointerMove={event => {
            const point = normalized(event);
            if (point) sender.move(point);
          }}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      ) : null}
      {rect ? (
        <canvas ref={canvasRef} className="lr-paint-canvas" style={rectStyle(rect)} aria-hidden="true" />
      ) : null}
      {rect ? (
        <span className="lr-paint-tools">
          <Btn icon="pencil" pressed={paintOn} tone={paintOn ? "on" : undefined}
            title={paintOn ? "interaction.paint.hide" : "interaction.paint.show"}
            onClick={() => setPaintOn(!paintOn)} />
          {paintOn ? (
            <>
              <PaintPalette color={color} onChange={setColor} />
              <Btn icon="refresh" title="interaction.paint.undo" disabled={!canUndo} onClick={undo} />
              {isHost ? (
                <Btn icon="x" title="interaction.paint.clear" disabled={!board.order.length}
                  onClick={() => session.sendPaint({ op: "clear", space: SPACE })} />
              ) : null}
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
