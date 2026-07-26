import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { FaTrashAlt } from "react-icons/fa";
import styles from "@/styles/EditorV2.module.css";
import { TransportBar } from "@/src/components/EditorV2/TransportBar";
import { SongsPanel } from "@/src/components/EditorV2/SongsPanel";
import { analyzeBpm, BpmAnalysis } from "@/src/components/EditorV2/bpm";
import { getSongUrl } from "@/src/utils/songUrl";
import { Song } from "@/src/types/Song";
import {
  publishTimeViewport,
  publishTransportTime,
} from "@/src/components/EditorV2/timeViewport";

const MAX_ZOOM = 64;
// Offscreen waveform resolution: the whole song rendered once at this many
// columns; browsers cap canvas dimensions around 32k. At MAX_ZOOM this gives
// several source pixels per screen pixel for typical songs.
const PEAK_COLUMNS = 32000;
const DIM_COLOR = "rgba(232, 236, 244, 0.35)";
const BRIGHT_COLOR = "rgba(232, 236, 244, 0.8)";

// Draw waveform bars for the time window [viewLeft, viewLeft + viewWidth)
// straight from the peak array, restricted to destination columns
// [fromX, toX). Each screen column max-pools its exact share of peak
// columns, so peaks stay crisp at every zoom, positions are exact, and
// there is no image scaling or level-of-detail switching to snap.
const drawBars = (
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  viewLeft: number,
  viewWidth: number,
  destWidth: number,
  height: number,
  fromX: number,
  toX: number,
  color: string,
) => {
  ctx.fillStyle = color;
  const first = Math.max(0, Math.floor(fromX));
  const last = Math.min(destWidth, Math.ceil(toX));
  for (let x = first; x < last; x++) {
    const f0 = viewLeft + viewWidth * (x / destWidth);
    const f1 = viewLeft + viewWidth * ((x + 1) / destWidth);
    const i0 = Math.floor(f0 * peaks.length);
    const i1 = Math.max(i0 + 1, Math.ceil(f1 * peaks.length));
    if (i0 < 0 || i0 >= peaks.length) continue;
    let max = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++)
      if (peaks[i] > max) max = peaks[i];
    const barHeight = Math.max(1, max * height);
    ctx.fillRect(x, (height - barHeight) / 2, 1, barHeight);
  }
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
};

type DragState = {
  startX: number;
  startY: number;
  startZoom: number;
  startCenterFrac: number;
  mapWidth: number;
};

// The timeline strip: transport on the left, then the song area. With no
// song loaded, an Add Song control opens a file picker; a loaded song shows
// as its waveform with a trash button at the far end. Above sits the
// minimap: the whole song with a viewfinder marking the visible portion
// (the automation lanes share this viewport). Drag the viewfinder sideways
// to pan, up to widen (zoom out), down to narrow (zoom in); click outside
// it to seek. Click the timeline waveform to seek.
//
// Rendering approach: wavesurfer is used purely as a hidden audio engine
// (decode, play, seek, rate). The song's peaks are painted ONCE into two
// offscreen canvases (dim and bright); every visible frame of both the
// timeline and the minimap is then a couple of drawImage calls sampling
// those offscreens, so pan/zoom redraw at full frame rate with no waveform
// re-render ever.
type Props = {
  song: Song | null;
  onSongChange: (song: Song | null) => void;
  volume: number;
  onBeatGridChange: (
    grid: (BpmAnalysis & { durationSeconds: number }) | null,
  ) => void;
};

export function TimelineStrip({
  song,
  onSongChange,
  volume,
  onBeatGridChange,
}: Props) {
  const songUrl = song ? (getSongUrl(song, true) ?? null) : null;
  const [isSongPanelOpen, setIsSongPanelOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  // Latest values for the async wavesurfer setup (see setUp below).
  const settings = useRef({ playbackRate: 1, volume });
  settings.current = { playbackRate, volume };
  const [bpmInfo, setBpmInfo] = useState<BpmAnalysis | null>(null);
  const beatGrid = useRef<BpmAnalysis | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement>(null);

  const getDisplayTime = () =>
    scrubTime.current ?? wavesurfer.current?.getCurrentTime() ?? 0;

  // Updated imperatively; timeupdate fires far too often for React state.
  // Each digit gets a fixed-width box so the label doesn't wiggle as
  // proportional-font digits change.
  const updateTimeLabel = () => {
    const label = timeLabelRef.current;
    const ws = wavesurfer.current;
    if (!label || !ws) return;
    const text = formatTime(getDisplayTime());
    if (label.dataset.time === text) return;
    label.dataset.time = text;
    label.replaceChildren(
      ...[...text].map((char) => {
        const span = document.createElement("span");
        span.className = /\d/.test(char)
          ? styles.timeDigit
          : styles.timeSeparator;
        span.textContent = char;
        return span;
      }),
    );
  };
  const audioHostRef = useRef<HTMLDivElement>(null);
  const timelineCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const wavesurfer = useRef<WaveSurfer | null>(null);

  const peaksRef = useRef<Float32Array | null>(null);
  // While scrubbing the timeline, the playhead follows this local position;
  // the real seek happens once on release. Seeking the media element per
  // mousemove is unreliable: seeks are async and coalesced, so positions
  // snap back and the final seek can be dropped.
  const scrubTime = useRef<number | null>(null);
  // The viewport: start time as a fraction of the song, and zoom (1 = whole
  // song visible). Plain refs; drawing is fully imperative.
  const view = useRef({ startFrac: 0, zoom: 1 });
  const drag = useRef<DragState | null>(null);
  const drawQueued = useRef(false);

  const getViewFractions = () => {
    const width = 1 / view.current.zoom;
    return {
      left: clamp(view.current.startFrac, 0, 1 - width),
      width,
    };
  };

  // Keep the shared time viewport (consumed by the automation editor) in
  // step with this timeline's view.
  const publishViewport = () => {
    const { left, width } = getViewFractions();
    publishTimeViewport(left, width);
  };

  const draw = () => {
    drawQueued.current = false;
    const ws = wavesurfer.current;
    const duration = ws?.getDuration() ?? 0;
    const progress = duration ? getDisplayTime() / duration : 0;
    publishTransportTime(getDisplayTime(), duration);
    const peaks = peaksRef.current;
    const viewFractions = getViewFractions();

    const timeline = timelineCanvasRef.current;
    const timelineCtx = timeline?.getContext("2d");
    if (timeline && timelineCtx) {
      const { width, height } = timeline;
      timelineCtx.clearRect(0, 0, width, height);
      // Beat grid behind the waveform: one line per beat, heavier every
      // fourth (a bar, assuming 4/4). Lines thin out as they crowd: below
      // ~14px per beat only bars draw; below ~7px per bar, nothing.
      const grid = beatGrid.current;
      if (grid && duration) {
        const beatFrac = 60 / grid.bpm / duration;
        const pxPerBeat = (beatFrac / viewFractions.width) * width;
        if (pxPerBeat >= 3.5) {
          const offsetFrac = grid.offsetSeconds / duration;
          const right = viewFractions.left + viewFractions.width;
          let k = Math.max(
            0,
            Math.ceil((viewFractions.left - offsetFrac) / beatFrac),
          );
          for (
            let frac = offsetFrac + k * beatFrac;
            frac <= right;
            k++, frac = offsetFrac + k * beatFrac
          ) {
            const isBar = k % 4 === 0;
            if (!isBar && pxPerBeat < 14) continue;
            const x =
              ((frac - viewFractions.left) / viewFractions.width) * width;
            timelineCtx.fillStyle = isBar
              ? "rgba(232, 236, 244, 0.26)"
              : "rgba(232, 236, 244, 0.1)";
            timelineCtx.fillRect(x, 0, 1, height);
          }
        }
      }

      if (peaks) {
        const playedFrac = clamp(
          (progress - viewFractions.left) / viewFractions.width,
          0,
          1,
        );
        const playedX = width * playedFrac;
        drawBars(
          timelineCtx,
          peaks,
          viewFractions.left,
          viewFractions.width,
          width,
          height,
          playedX,
          width,
          DIM_COLOR,
        );
        if (playedFrac > 0)
          drawBars(
            timelineCtx,
            peaks,
            viewFractions.left,
            viewFractions.width,
            width,
            height,
            0,
            playedX,
            BRIGHT_COLOR,
          );
        // Cursor: gold, matching the minimap viewfinder.
        if (progress >= viewFractions.left - 0.0001 && playedFrac <= 1) {
          timelineCtx.fillStyle = "#e4be5a";
          timelineCtx.fillRect(playedX - 1, 0, 2, height);
        }
      }
    }

    const minimap = minimapCanvasRef.current;
    const minimapCtx = minimap?.getContext("2d");
    if (minimap && minimapCtx) {
      const { width, height } = minimap;
      minimapCtx.clearRect(0, 0, width, height);
      if (peaks) {
        // The minimap always shows the whole song.
        const playedX = width * clamp(progress, 0, 1);
        drawBars(
          minimapCtx,
          peaks,
          0,
          1,
          width,
          height,
          playedX,
          width,
          DIM_COLOR,
        );
        if (playedX > 0)
          drawBars(
            minimapCtx,
            peaks,
            0,
            1,
            width,
            height,
            0,
            playedX,
            BRIGHT_COLOR,
          );
      }
      // Viewfinder. Gold, so it stays visible against the silver-white
      // waveform beneath it.
      const x = viewFractions.left * width;
      const w = Math.max(2, viewFractions.width * width);
      minimapCtx.fillStyle = "rgba(212, 175, 55, 0.16)";
      minimapCtx.fillRect(x, 0, w, height);
      minimapCtx.strokeStyle = "rgba(228, 190, 90, 0.9)";
      minimapCtx.lineWidth = 1;
      minimapCtx.strokeRect(x + 0.5, 0.5, w - 1, height - 1);
    }
  };

  const requestDraw = () => {
    if (drawQueued.current) return;
    drawQueued.current = true;
    requestAnimationFrame(draw);
  };

  // Compute the whole song's peaks once. Every visible frame max-pools
  // straight from this array (drawBars), so there are no prerendered
  // images to scale and nothing to misalign or collapse.
  const buildPeaks = () => {
    const decoded = wavesurfer.current?.getDecodedData();
    if (!decoded) {
      peaksRef.current = null;
      return;
    }
    const data = decoded.getChannelData(0);
    const columns = Math.min(PEAK_COLUMNS, data.length);
    const samplesPerColumn = Math.max(1, Math.floor(data.length / columns));
    const stride = Math.max(1, Math.floor(samplesPerColumn / 16));

    const peaks = new Float32Array(columns);
    for (let column = 0; column < columns; column++) {
      const start = column * samplesPerColumn;
      const end = Math.min(start + samplesPerColumn, data.length);
      let max = 0;
      for (let i = start; i < end; i += stride) {
        const value = Math.abs(data[i]);
        if (value > max) max = value;
      }
      peaks[column] = max;
    }
    peaksRef.current = peaks;
  };

  // Size the visible canvases to their containers in device pixels.
  useEffect(() => {
    if (!songUrl) return;
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of [
        timelineCanvasRef.current,
        minimapCanvasRef.current,
      ]) {
        if (!canvas || !canvas.parentElement) continue;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      }
      requestDraw();
    });
    if (timelineCanvasRef.current?.parentElement)
      observer.observe(timelineCanvasRef.current.parentElement);
    if (minimapCanvasRef.current?.parentElement)
      observer.observe(minimapCanvasRef.current.parentElement);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songUrl]);

  useEffect(() => {
    const host = audioHostRef.current;
    if (!songUrl || !host) return;

    // The whole file is fetched up front and handed over as a blob: URL,
    // so the media element plays from memory. Streaming straight from the
    // song URL instead leaves playback at the browser's mercy: it can
    // drop buffered audio in a long-lived tab and stall mid-play on the
    // refetch (play, hiccup, resume). Wavesurfer fully downloads the URL
    // to decode peaks anyway, so this costs no extra transfer.
    let cancelled = false;
    let ws: WaveSurfer | null = null;
    let objectUrl: string | null = null;
    const setUp = (url: string) => {
      if (cancelled) return;
      ws = createWavesurfer(host, url);
      // Setup is async (behind the fetch), so the volume and rate
      // effects may already have run against no instance.
      ws.setPlaybackRate(settings.current.playbackRate);
      ws.setVolume(settings.current.volume);
      wavesurfer.current = ws;
      view.current = { startFrac: 0, zoom: 1 };
      publishViewport();
    };
    fetch(songUrl)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUp(objectUrl);
      })
      // On any fetch failure, fall back to streaming from the source.
      .catch(() => setUp(songUrl));

    return () => {
      cancelled = true;
      ws?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      wavesurfer.current = null;
      peaksRef.current = null;
      beatGrid.current = null;
      setBpmInfo(null);
      onBeatGridChange(null);
      publishTimeViewport(0, 1);
      publishTransportTime(0, 0);
      setIsPlaying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songUrl]);

  const createWavesurfer = (host: HTMLElement, url: string) => {
    const ws = WaveSurfer.create({
      container: host,
      url,
      height: 0,
      interact: false,
      // Wavesurfer's own follow-the-playhead behaviors; its container is
      // hidden, but leaving them on costs scroll work per timeupdate.
      autoScroll: false,
      autoCenter: false,
    });
    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("finish", () => setIsPlaying(false));
    ws.on("decode", () => {
      buildPeaks();
      requestDraw();
      // Tempo analysis runs in the background; the grid appears when done.
      const decoded = ws.getDecodedData();
      if (decoded)
        analyzeBpm(decoded)
          .then((analysis) => {
            // The song may have been swapped mid-analysis.
            if (wavesurfer.current !== ws) return;
            beatGrid.current = analysis;
            setBpmInfo(analysis);
            onBeatGridChange(
              analysis
                ? { ...analysis, durationSeconds: ws.getDuration() }
                : null,
            );
            requestDraw();
          })
          .catch(() => {});
    });
    ws.on("timeupdate", () => {
      // The viewport never follows the playhead: the minimap is the only
      // thing that moves the view, and playback is free to run off-screen.
      updateTimeLabel();
      requestDraw();
    });
    return ws;
  };

  useEffect(() => {
    wavesurfer.current?.setPlaybackRate(playbackRate);
  }, [playbackRate, songUrl]);

  useEffect(() => {
    wavesurfer.current?.setVolume(volume);
  }, [volume, songUrl]);

  // Spacebar toggles play/stop, unless typing in a field. preventDefault
  // keeps a focused button from also activating on the same press.
  useEffect(() => {
    if (!songUrl) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " ") return;
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      event.preventDefault();
      wavesurfer.current?.playPause();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [songUrl]);

  const removeSong = () => onSongChange(null);

  const seekToFraction = (frac: number) => {
    const ws = wavesurfer.current;
    if (!ws || !ws.getDuration()) return;
    ws.setTime(clamp(frac, 0, 1) * ws.getDuration());
    updateTimeLabel();
    requestDraw();
  };

  const onMinimapPointerDown = (event: React.PointerEvent) => {
    const canvas = minimapCanvasRef.current;
    if (!canvas || !wavesurfer.current?.getDuration()) return;
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const viewFractions = getViewFractions();

    // The minimap never controls playback; only the viewfinder is
    // interactive.
    if (
      frac < viewFractions.left ||
      frac > viewFractions.left + viewFractions.width
    )
      return;

    // Inside: drag to pan (x) and zoom (y). Pure viewport math + redraw;
    // nothing is re-rendered.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      startZoom: view.current.zoom,
      startCenterFrac: viewFractions.left + viewFractions.width / 2,
      mapWidth: rect.width,
    };

    const onMove = (moveEvent: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const zoom = clamp(
        state.startZoom * Math.exp((moveEvent.clientY - state.startY) * 0.008),
        1,
        MAX_ZOOM,
      );
      const width = 1 / zoom;
      const centerFrac = clamp(
        state.startCenterFrac +
          (moveEvent.clientX - state.startX) / state.mapWidth,
        width / 2,
        1 - width / 2,
      );
      view.current = { zoom, startFrac: centerFrac - width / 2 };
      publishViewport();
      requestDraw();
    };
    const onUp = () => {
      drag.current = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  // Grab cursor over the viewfinder, pointer elsewhere.
  const onMinimapHover = (event: React.PointerEvent) => {
    if (drag.current) return;
    const canvas = minimapCanvasRef.current;
    if (!canvas || !wavesurfer.current?.getDuration()) return;
    const rect = canvas.getBoundingClientRect();
    const frac = (event.clientX - rect.left) / rect.width;
    const viewFractions = getViewFractions();
    canvas.style.cursor =
      frac >= viewFractions.left &&
      frac <= viewFractions.left + viewFractions.width
        ? "grab"
        : "default";
  };

  // Click to move the playhead; keep dragging to scrub it. The view itself
  // never moves. The playhead follows a local position during the drag and
  // the audio seeks ONCE on release (per-move seeks are async, coalesced,
  // and unreliable).
  const onTimelinePointerDown = (event: React.PointerEvent) => {
    const canvas = timelineCanvasRef.current;
    const ws = wavesurfer.current;
    if (!canvas || !ws?.getDuration()) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}

    const duration = ws.getDuration();
    const rect = canvas.getBoundingClientRect();
    const scrubAtClientX = (clientX: number) => {
      const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
      const viewFractions = getViewFractions();
      scrubTime.current =
        clamp(viewFractions.left + frac * viewFractions.width, 0, 1) * duration;
      updateTimeLabel();
      requestDraw();
    };
    scrubAtClientX(event.clientX);

    const onMove = (moveEvent: PointerEvent) =>
      scrubAtClientX(moveEvent.clientX);
    const onUp = () => {
      const target = scrubTime.current;
      scrubTime.current = null;
      if (target !== null) ws.setTime(target);
      updateTimeLabel();
      requestDraw();
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  return (
    <section className={styles.timelineArea}>
      <div className={styles.transport}>
        {songUrl && (
          <span
            ref={timeLabelRef}
            className={styles.timeLabel}
            data-doc="current-time"
          >
            {[..."0:00.0"].map((char, index) => (
              <span
                key={index}
                className={
                  /\d/.test(char) ? styles.timeDigit : styles.timeSeparator
                }
              >
                {char}
              </span>
            ))}
          </span>
        )}
        <TransportBar
          canPlay={!!songUrl}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          onPlayStop={() => wavesurfer.current?.playPause()}
          onGoToStart={() => seekToFraction(0)}
          onGoToEnd={() => seekToFraction(1)}
          onSkip={(seconds) => wavesurfer.current?.skip(seconds)}
          onRateChange={setPlaybackRate}
        />
      </div>
      <div className={styles.timelineRight}>
        <div className={styles.minimapRow} data-doc="minimap">
          {songUrl && (
            <canvas
              ref={minimapCanvasRef}
              className={styles.minimapCanvas}
              onPointerDown={onMinimapPointerDown}
              onPointerMove={onMinimapHover}
            />
          )}
        </div>
        <div
          className={`${styles.timelineTicks} ${
            songUrl ? "" : styles.timelineTicksEmpty
          }`}
          data-doc="timeline"
        >
          <div ref={audioHostRef} className={styles.audioHost} />
          {songUrl ? (
            <>
              <canvas
                ref={timelineCanvasRef}
                className={styles.waveform}
                data-doc="timeline"
                onPointerDown={onTimelinePointerDown}
              />
              {bpmInfo && (
                <span className={styles.bpmLabel} data-doc="bpm">
                  {Math.round(bpmInfo.bpm * 10) / 10} BPM
                </span>
              )}
              <button
                data-doc="remove-song"
                className={styles.removeSong}
                onClick={removeSong}
                aria-label="Remove song"
              >
                <FaTrashAlt />
              </button>
            </>
          ) : (
            <>
              <div className={styles.playhead} />
              <button
                data-doc="add-song"
                className={styles.addSong}
                onClick={() => setIsSongPanelOpen(true)}
              >
                Add Song
              </button>
            </>
          )}
        </div>
      </div>

      <SongsPanel
        isOpen={isSongPanelOpen}
        onClose={() => setIsSongPanelOpen(false)}
        onSelectSong={(selected) => {
          setIsSongPanelOpen(false);
          onSongChange(selected);
        }}
      />
    </section>
  );
}
