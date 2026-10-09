import { useState } from "react";
import { PAINT_COLORS } from "../../../shared/room-interactions";
import { useCopy } from "../../ui/copy";
import { Btn } from "./primitives";
import "./room-paint.css";

/** Current-color button that opens a small palette grid. */
export function PaintPalette({ color, onChange }: { color: number; onChange: (index: number) => void }) {
  const { t } = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <span className="lr-paint-palette">
      <Btn icon="palette" title="interaction.paint.color" pressed={open} tone={open ? "on" : undefined}
        onClick={() => setOpen(!open)} />
      <span className="lr-paint-current" style={{ background: PAINT_COLORS[color] }} aria-hidden="true" />
      {open ? (
        <span className="lr-paint-palette-grid" role="group" aria-label={t("interaction.paint.color")}>
          {PAINT_COLORS.map((hex, index) => (
            <button key={hex} type="button" className="lr-paint-swatch" style={{ background: hex }}
              aria-pressed={color === index} aria-label={hex}
              onClick={() => { onChange(index); setOpen(false); }} />
          ))}
        </span>
      ) : null}
    </span>
  );
}
