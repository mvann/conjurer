import { ReactNode, useEffect, useRef, useState } from "react";
import { FaVolumeMute, FaVolumeUp } from "react-icons/fa";
import { WiDust } from "react-icons/wi";
import styles from "@/styles/EditorV2.module.css";

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

function CornerSlider({
  icon,
  ariaLabel,
  docKey,
  value,
  onChange,
  isOpen,
  onToggle,
}: {
  icon: ReactNode;
  ariaLabel: string;
  docKey: string;
  value: number;
  onChange: (value: number) => void;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    const setFromClientY = (clientY: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      onChange(clamp01(1 - (clientY - rect.top) / rect.height));
    };
    setFromClientY(event.clientY);
    const onMove = (moveEvent: PointerEvent) =>
      setFromClientY(moveEvent.clientY);
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={styles.cornerControl} data-doc={docKey}>
      {isOpen && (
        <div className={styles.sliderPopover} onPointerDown={onPointerDown}>
          <div ref={trackRef} className={styles.sliderTrack}>
            <div
              className={styles.sliderFill}
              style={{ height: `${value * 100}%` }}
            />
            <div
              className={styles.sliderHandle}
              style={{ bottom: `calc(${value * 100}% - 4px)` }}
            />
          </div>
        </div>
      )}
      <button
        className={`${styles.cornerButton} ${
          isOpen || value > 0.001 ? styles.cornerButtonActive : ""
        }`}
        onClick={onToggle}
        aria-label={ariaLabel}
      >
        {icon}
      </button>
    </div>
  );
}

// Bottom-right corner of the canopy view: volume and dust, each a button
// that pops a vertical slider above itself.
export function CanopyControls({
  volume,
  onVolumeChange,
  dust,
  onDustChange,
}: {
  volume: number;
  onVolumeChange: (value: number) => void;
  dust: number;
  onDustChange: (value: number) => void;
}) {
  const [openSlider, setOpenSlider] = useState<"volume" | "dust" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away closes the open slider.
  useEffect(() => {
    if (!openSlider) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpenSlider(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openSlider]);

  return (
    <div ref={rootRef} className={styles.canopyControls}>
      <CornerSlider
        icon={volume <= 0.001 ? <FaVolumeMute /> : <FaVolumeUp />}
        ariaLabel="Volume"
        docKey="volume"
        value={volume}
        onChange={onVolumeChange}
        isOpen={openSlider === "volume"}
        onToggle={() =>
          setOpenSlider(openSlider === "volume" ? null : "volume")
        }
      />
      <CornerSlider
        icon={<WiDust size={24} />}
        ariaLabel="Dust"
        docKey="dust"
        value={dust}
        onChange={onDustChange}
        isOpen={openSlider === "dust"}
        onToggle={() => setOpenSlider(openSlider === "dust" ? null : "dust")}
      />
    </div>
  );
}
