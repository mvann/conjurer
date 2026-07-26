import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import styles from "@/styles/EditorV2.module.css";
import { Palette, SerializedPalette } from "@/src/params/palette/Palette";
import { PALETTE_PRESETS } from "@/src/params/palette/presets";
import { hexToRgb } from "@/src/utils/color";

// Shared color and palette editors, used both by the pattern list (to
// edit a parameter's value) and by the automation editor's inspector (to
// edit a keyframe's payload). Mirrors the main app's controls: a hex
// color picker for colors, and the curated cosine-palette presets with
// fine coefficient scrubs for palettes, restyled to the house look.

export type Rgba = [number, number, number, number];

export const rgbaToCss = (rgba: Rgba) =>
  `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(
    rgba[2] * 255,
  )}, ${rgba[3]})`;

export const rgbaToHex = (rgba: Rgba) => {
  const channel = (value: number) =>
    Math.round(Math.min(Math.max(value, 0), 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgba[0])}${channel(rgba[1])}${channel(rgba[2])}`;
};

// CSS gradient sampling the cosine palette across its period.
export const paletteToGradientCss = (serialized: SerializedPalette) => {
  const palette = Palette.deserialize(serialized);
  const stops: string[] = [];
  const samples = 16;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const color = palette.colorAt(t);
    stops.push(
      `rgb(${Math.round(color.x * 255)}, ${Math.round(color.y * 255)}, ${Math.round(
        color.z * 255,
      )}) ${Math.round(t * 100)}%`,
    );
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
};

export function ColorValueEditor({
  rgba,
  onChange,
}: {
  rgba: Rgba;
  onChange: (next: Rgba) => void;
}) {
  // The picker owns the hex while interacting; outside changes (another
  // segment selected, automation restored by undo) re-sync it.
  const [hex, setHex] = useState(rgbaToHex(rgba));
  const external = rgbaToHex(rgba);
  const lastExternal = useRef(external);
  useEffect(() => {
    if (external !== lastExternal.current) {
      lastExternal.current = external;
      setHex(external);
    }
  }, [external]);

  const onHexChange = (nextHex: string) => {
    setHex(nextHex);
    const rgb = hexToRgb(nextHex);
    onChange([rgb.r / 255, rgb.g / 255, rgb.b / 255, rgba[3]]);
  };

  return (
    <div className={styles.colorEditor} data-doc="color-editor">
      <HexColorPicker color={hex} onChange={onHexChange} />
      <div className={styles.inspectorRow}>
        <span className={styles.inspectorLabel}>Hex</span>
        <input
          className={styles.paramInput}
          value={hex}
          onChange={(event) => onHexChange(event.target.value)}
        />
      </div>
    </div>
  );
}

export function PaletteValueEditor({
  palette,
  onChange,
}: {
  palette: SerializedPalette;
  onChange: (next: SerializedPalette) => void;
}) {
  const setCoefficient = (
    vector: "a" | "b" | "c" | "d",
    channel: 0 | 1 | 2,
    value: number,
  ) => {
    const next: SerializedPalette = {
      a: [...palette.a],
      b: [...palette.b],
      c: [...palette.c],
      d: [...palette.d],
    } as SerializedPalette;
    next[vector][channel] = value;
    onChange(next);
  };

  return (
    <div className={styles.paletteEditor} data-doc="palette-editor">
      <div
        className={styles.paletteEditorPreview}
        style={{ background: paletteToGradientCss(palette) }}
      />
      <div className={styles.inspectorRow}>
        {PALETTE_PRESETS.map((preset) => {
          const serialized = preset.make().serialize();
          return (
            <button
              key={preset.name}
              className={styles.palettePresetSwatch}
              title={preset.name}
              aria-label={`Palette preset ${preset.name}`}
              style={{ background: paletteToGradientCss(serialized) }}
              onClick={() => onChange(serialized)}
            />
          );
        })}
      </div>
      <div className={styles.paletteCoefficients}>
        {(["a", "b", "c", "d"] as const).map((vector) => (
          <div key={vector} className={styles.paletteCoefficientRow}>
            <span className={styles.paletteCoefficientName}>{vector}</span>
            {([0, 1, 2] as const).map((channel) => (
              <PaletteScrub
                key={channel}
                value={palette[vector][channel]}
                onChange={(value) => setCoefficient(vector, channel, value)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// A minimal scrubbable number for palette coefficients: drag to change,
// like the pattern list's numbers, but writing through a callback.
function PaletteScrub({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let lastY = event.clientY;
    let raw = value;
    const onMove = (moveEvent: PointerEvent) => {
      const step = moveEvent.shiftKey ? 0.001 : 0.01;
      raw += (lastY - moveEvent.clientY) * step;
      lastY = moveEvent.clientY;
      onChange(Math.round(raw * 1000) / 1000);
    };
    const end = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
  };

  return (
    <span
      className={`${styles.paramValue} ${styles.paramScrub}`}
      onPointerDown={onPointerDown}
      title="Drag to change · shift for fine"
    >
      {String(Math.round(value * 100) / 100)}
    </span>
  );
}
