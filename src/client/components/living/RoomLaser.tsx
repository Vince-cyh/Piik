import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type RefObject } from "react";
import { LASER_TRAIL_MS } from "../../../shared/room-interactions";
import { RoomInteractionSession } from "../../lib/room-interactions";
import { participantColor } from "./participant-color";
import { Btn } from "./primitives";
import "./room-laser.css";

// Stay under the server's per-sender laser pace; lost frames are fine.
const LASER_SEND_MS = 70;
// The head dot hides quickly when a sender stops, the trail fades slowly.
const LASER_HEAD_MS = 900;

interface ContentRect { x: number; y: number; w: number; h: number }
interface TrailPoint { x: number; y: number; t: number; fresh: boolean }
interface PeerTrail { name: string; color: string; points: TrailPoint[]; lastId: string | null }

export function RoomLaser({ session, videoRef, active }: {
  session: RoomInteractionSession | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  active: boolean;
}) {
  return session && active ? <ConnectedLaser key={session.key} session={session} videoRef={videoRef} /> : null;
}

function ConnectedLaser({ session, videoRef }: {
  session: RoomInteractionSession;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const { lasers, peerId } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trailsRef = useRef(new Map<string, PeerTrail>());
  const localTrailRef = useRef<TrailPoint[]>([]);
  const localFreshRef = useRef(true);
  const lastSentAtRef = useRef(0);
  const lastPointRef = useRef({ x: 0, y: 0 });
  const [rect, setRect] = useState<ContentRect | null>(null);
  const [laserOn, setLaserOn] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [, setTick] = useState(0);

  // object-fit: contain letterboxes the picture; coordinates travel normalized
  // to the picture itself, so both sides map through the same content rect.
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

  // Fold newly arrived positions into per-sender trails (dedupe by event id).
  useEffect(() => {
    const trails = trailsRef.current;
    for (const [peer, laser] of Object.entries(lasers)) {
      let trail = trails.get(peer);
      if (!trail) {
        trail = { name: laser.displayName, color: participantColor(peer), points: [], lastId: null };
        trails.set(peer, trail);
      }
      if (trail.lastId === laser.id) continue;
      trail.points.push({ x: laser.x, y: laser.y, t: laser.at, fresh: trail.lastId === null });
      trail.lastId = laser.id;
      setAnimating(true);
    }
    // A sender that lifted the pointer leaves the snapshot; its trail fades.
    for (const [peer, trail] of trails) {
      if (!(peer in lasers)) trail.lastId = null;
    }
  }, [lasers]);

  // Fade and prune trails at display rate while anything is on screen.
  useEffect(() => {
    if (!animating) return;
    let live = true;
    let raf = requestAnimationFrame(function step() {
      if (!live) return;
      const now = Date.now();
      let remaining = 0;
      for (const [peer, trail] of trailsRef.current) {
        trail.points = trail.points.filter(point => now - point.t < LASER_TRAIL_MS);
        if (!trail.points.length && trail.lastId === null) trailsRef.current.delete(peer);
        else remaining += 1;
      }
      localTrailRef.current = localTrailRef.current.filter(point => now - point.t < LASER_TRAIL_MS);
      if (localTrailRef.current.length) remaining += 1;
      setTick(tick => tick + 1);
      if (remaining) raf = requestAnimationFrame(step);
      else setAnimating(false);
    });
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [animating]);

  const pointFrom = (event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return null;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };

  const lift = () => {
    if (localFreshRef.current) return;
    localFreshRef.current = true;
    session.sendLaser(lastPointRef.current.x, lastPointRef.current.y, "up");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const point = pointFrom(event);
    if (!point) return;
    const now = Date.now();
    if (now - lastSentAtRef.current < LASER_SEND_MS) return;
    lastSentAtRef.current = now;
    lastPointRef.current = point;
    session.sendLaser(point.x, point.y, "move");
    localTrailRef.current.push({ x: point.x, y: point.y, t: now, fresh: localFreshRef.current });
    localFreshRef.current = false;
    setAnimating(true);
  };

  const toggleLaser = () => {
    if (laserOn) lift();
    setLaserOn(!laserOn);
  };

  const rectStyle = (area: ContentRect): CSSProperties => ({
    left: area.x, top: area.y, width: area.w, height: area.h,
  });
  const now = Date.now();
  const selfColor = participantColor(peerId ?? "local");

  return (
    <div className="lr-laser" ref={rootRef}>
      {rect && laserOn ? (
        <div className="lr-laser-capture" style={rectStyle(rect)}
          onPointerMove={onPointerMove} onPointerLeave={lift} onPointerCancel={lift} />
      ) : null}
      {rect ? (
        <div className="lr-laser-view" style={rectStyle(rect)}>
          <svg className="lr-laser-trails" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            {[...trailsRef.current.entries()].map(([peer, trail]) => {
              const segments = [];
              const points = trail.points;
              for (let index = 1; index < points.length; index += 1) {
                const from = points[index - 1];
                const to = points[index];
                if (!from || !to || to.fresh) continue;
                const opacity = 1 - (now - to.t) / LASER_TRAIL_MS;
                if (opacity <= 0) continue;
                segments.push(<line key={`${peer}:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  stroke={trail.color} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke"
                  opacity={opacity} />);
              }
              return <g key={peer}>{segments}</g>;
            })}
            {localTrailRef.current.map((point, index, points) => {
              if (index === 0 || point.fresh) return null;
              const from = points[index - 1];
              if (!from) return null;
              const opacity = 1 - (now - point.t) / LASER_TRAIL_MS;
              if (opacity <= 0) return null;
              return <line key={`local:${index}`} x1={from.x} y1={from.y} x2={point.x} y2={point.y}
                stroke={selfColor} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke"
                opacity={opacity} />;
            })}
          </svg>
          {[...trailsRef.current.entries()].map(([peer, trail]) => {
            const last = trail.points[trail.points.length - 1];
            if (!last || !(peer in lasers) || now - last.t >= LASER_HEAD_MS) return null;
            return (
              <span key={`dot:${peer}`} className="lr-laser-dot"
                style={{ left: `${last.x * 100}%`, top: `${last.y * 100}%`, color: trail.color }}>
                <span className="lr-laser-name">{trail.name}</span>
              </span>
            );
          })}
          {(() => {
            const points = localTrailRef.current;
            const last = points[points.length - 1];
            if (!laserOn || !last || now - last.t >= LASER_HEAD_MS) return null;
            return <span className="lr-laser-dot"
              style={{ left: `${last.x * 100}%`, top: `${last.y * 100}%`, color: selfColor }} />;
          })()}
          <span className="lr-laser-toggle">
            <Btn icon="laser" pressed={laserOn} tone={laserOn ? "on" : undefined}
              title={laserOn ? "interaction.laser.hide" : "interaction.laser.show"} onClick={toggleLaser} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
