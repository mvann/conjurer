import { FaPause, FaPlay, FaStepBackward, FaStepForward } from "react-icons/fa";
import { MdForward10, MdReplay10 } from "react-icons/md";
import styles from "@/styles/EditorV2.module.css";

export const PLAYBACK_RATES = [1, 0.5, 0.25] as const;

type Props = {
  canPlay: boolean;
  isPlaying: boolean;
  playbackRate: number;
  onPlayStop: () => void;
  onGoToStart: () => void;
  onGoToEnd: () => void;
  onSkip: (seconds: number) => void;
  onRateChange: (rate: number) => void;
};

// Transport at the timeline's left end, mirroring the standard experience
// editor's controls: go to start, play/stop, go to end, skip back and
// forward ten seconds, and playback rate. All controls are disabled until a
// song is loaded into the timeline.
export function TransportBar({
  canPlay,
  isPlaying,
  playbackRate,
  onPlayStop,
  onGoToStart,
  onGoToEnd,
  onSkip,
  onRateChange,
}: Props) {
  const disabledTitle = canPlay ? undefined : "Load a song to play";

  return (
    <>
      <div className={styles.transportRow}>
        <button
          data-doc="transport-start"
          className={styles.transportButton}
          disabled={!canPlay}
          title={disabledTitle}
          onClick={onGoToStart}
          aria-label="Go to start"
        >
          <FaStepBackward size={11} />
        </button>
        <button
          data-doc="transport-play"
          className={styles.transportButton}
          disabled={!canPlay}
          title={disabledTitle}
          onClick={onPlayStop}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <FaPause size={12} /> : <FaPlay size={12} />}
        </button>
        <button
          data-doc="transport-end"
          className={styles.transportButton}
          disabled={!canPlay}
          title={disabledTitle}
          onClick={onGoToEnd}
          aria-label="Go to end"
        >
          <FaStepForward size={11} />
        </button>
      </div>
      <div className={styles.transportRow}>
        <button
          data-doc="transport-back10"
          className={styles.transportButton}
          disabled={!canPlay}
          title={disabledTitle}
          onClick={() => onSkip(-10)}
          aria-label="Go back 10 seconds"
        >
          <MdReplay10 size={16} />
        </button>
        <button
          data-doc="transport-forward10"
          className={styles.transportButton}
          disabled={!canPlay}
          title={disabledTitle}
          onClick={() => onSkip(10)}
          aria-label="Go forward 10 seconds"
        >
          <MdForward10 size={16} />
        </button>
        <select
          data-doc="transport-rate"
          className={styles.transportRate}
          disabled={!canPlay}
          title={disabledTitle}
          aria-label="Playback speed"
          value={playbackRate}
          onChange={(event) => onRateChange(Number(event.target.value))}
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
