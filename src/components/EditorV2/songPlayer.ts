// The timeline's audio engine: a bare HTMLAudioElement fed a fully
// fetched blob, plus a one-shot decode for peaks and BPM analysis.
//
// This replaces wavesurfer, which the editor only ever used as a wrapper
// around exactly these two things — all waveform rendering, scrubbing,
// and viewport logic is our own. Owning the audio path outright means
// playback quirks (dropped seeks, stalls, event cadence) have no
// third-party layer to hide in.
//
// Playing from a blob: URL keeps the media element entirely in memory:
// no range requests, no mid-play rebuffering, instant seeks. On fetch
// failure the source URL is used directly as a degraded fallback.

type PlayerEvent = "play" | "pause" | "finish" | "decode" | "timeupdate";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// The rendered playback clock never trusts media.currentTime frame to
// frame: around playback start, Chromium's media clock can run briefly,
// freeze for a few hundred milliseconds while output syncs to the audio
// hardware clock, then jump forward — which a naive playhead renders as
// move, stop, continue. While playing, time is projected on the wall
// clock and only BENT toward the media clock, within these rate limits
// (fractions of playback speed), so brief clock freezes and the
// catch-up jump after them are both absorbed invisibly.
const MAX_SLOWDOWN = 0.1; // cursor never runs slower than 0.9x
const MAX_CATCHUP = 0.5; // nor faster than 1.5x
// Drift beyond this is a genuine discontinuity (external seek): snap.
const SNAP_SECONDS = 1;

export class SongPlayer {
  private media = new Audio();
  private decoded: AudioBuffer | null = null;
  private listeners = new Map<PlayerEvent, Set<() => void>>();
  private frame: number | null = null;
  private objectUrl: string | null = null;
  private destroyed = false;
  // Smoothed playback clock (see the constants above); null when the
  // raw media clock is authoritative (paused, or just seeked).
  private smoothed: number | null = null;
  private lastTickWall = 0;
  private lastDriftWarn = 0;

  constructor(private url: string) {
    this.media.preload = "auto";
    this.media.addEventListener("play", this.onPlay);
    this.media.addEventListener("pause", this.onPause);
    this.media.addEventListener("ended", this.onEnded);
    this.media.addEventListener("timeupdate", this.onMediaTimeUpdate);
  }

  // Fetch, hand the blob to the media element, and decode it for
  // analysis. Emits "decode" when the audio is ready either way.
  async load() {
    let blob: Blob | null = null;
    try {
      const response = await fetch(this.url);
      if (response.ok) blob = await response.blob();
    } catch {}
    if (this.destroyed) return;

    if (blob) {
      this.objectUrl = URL.createObjectURL(blob);
      this.media.src = this.objectUrl;
      try {
        const AudioContextClass =
          window.AudioContext ??
          (window as unknown as Record<string, typeof AudioContext>)
            .webkitAudioContext;
        const context = new AudioContextClass();
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        context.close().catch(() => {});
        if (this.destroyed) return;
        this.decoded = decoded;
      } catch {}
    } else {
      this.media.src = this.url;
    }
    this.emit("decode");
  }

  on(event: PlayerEvent, callback: () => void) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
  }

  getDecodedData() {
    return this.decoded;
  }

  getDuration() {
    if (this.decoded) return this.decoded.duration;
    return Number.isFinite(this.media.duration) ? this.media.duration : 0;
  }

  getCurrentTime() {
    return this.isPlaying() && this.smoothed !== null
      ? this.smoothed
      : this.media.currentTime;
  }

  setTime(seconds: number) {
    const target = clamp(seconds, 0, this.getDuration());
    this.media.currentTime = target;
    // Deliberate seeks move the rendered clock instantly.
    if (this.smoothed !== null) {
      this.smoothed = target;
      this.lastTickWall = performance.now();
    }
  }

  skip(seconds: number) {
    this.setTime(this.getCurrentTime() + seconds);
  }

  isPlaying() {
    return !this.media.paused && !this.media.ended;
  }

  playPause() {
    if (this.isPlaying()) this.media.pause();
    else this.media.play().catch(() => {});
  }

  setVolume(volume: number) {
    this.media.volume = clamp(volume, 0, 1);
  }

  setPlaybackRate(rate: number) {
    // preservesPitch is the default, matching the previous behavior;
    // set explicitly since some browsers default it off.
    this.media.preservesPitch = true;
    this.media.playbackRate = rate;
  }

  destroy() {
    this.destroyed = true;
    this.stopTicking();
    this.media.pause();
    this.media.removeEventListener("play", this.onPlay);
    this.media.removeEventListener("pause", this.onPause);
    this.media.removeEventListener("ended", this.onEnded);
    this.media.removeEventListener("timeupdate", this.onMediaTimeUpdate);
    this.media.removeAttribute("src");
    this.media.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.listeners.clear();
    this.decoded = null;
  }

  private emit(event: PlayerEvent) {
    const set = this.listeners.get(event);
    if (set) for (const callback of set) callback();
  }

  // Media timeupdate only fires a few times a second; while playing, a
  // rAF loop advances the smoothed clock and emits our timeupdate every
  // frame so the playhead glides.
  private tick = () => {
    if (this.destroyed || !this.isPlaying()) {
      this.frame = null;
      return;
    }
    this.advanceClock();
    this.emit("timeupdate");
    this.frame = requestAnimationFrame(this.tick);
  };

  // One smoothing step: project the rendered clock forward on the wall
  // clock, then bend it toward the raw media clock within the rate
  // limits. A media-clock freeze slows the cursor to at worst 0.9x; the
  // jump when it recovers plays back at at most 1.5x; neither reads as
  // a stall or a jump.
  private advanceClock() {
    const now = performance.now();
    const raw = this.media.currentTime;
    if (this.smoothed === null) {
      this.smoothed = raw;
      this.lastTickWall = now;
      return;
    }
    const rate = this.media.playbackRate;
    // Clamped so a background-tab gap doesn't project far past the audio.
    const dt = clamp((now - this.lastTickWall) / 1000, 0, 0.1);
    this.lastTickWall = now;
    let next = this.smoothed + dt * rate;
    const drift = raw - next;
    if (Math.abs(drift) > SNAP_SECONDS) {
      // A discontinuity we didn't cause (external seek): follow it.
      next = raw;
    } else {
      const limit = dt * rate * (drift > 0 ? MAX_CATCHUP : MAX_SLOWDOWN);
      next += clamp(drift, -limit, limit);
      // Breadcrumb for chasing playback-clock trouble in the field: a
      // drift this large means the media clock froze or leapt underneath
      // the (still-smooth) playhead.
      if (Math.abs(drift) > 0.3 && now - this.lastDriftWarn > 2_000) {
        this.lastDriftWarn = now;
        console.warn(
          `[SongPlayer] media clock drifted ${drift.toFixed(3)}s from ` +
            `smooth playback at t=${raw.toFixed(3)}s; bridging.`,
        );
      }
    }
    this.smoothed = next;
  }

  private stopTicking() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private onPlay = () => {
    this.smoothed = this.media.currentTime;
    this.lastTickWall = performance.now();
    this.emit("play");
    this.stopTicking();
    this.frame = requestAnimationFrame(this.tick);
  };

  private onPause = () => {
    this.stopTicking();
    this.smoothed = null;
    this.emit("pause");
    this.emit("timeupdate");
  };

  private onEnded = () => {
    this.stopTicking();
    this.smoothed = null;
    this.emit("finish");
    this.emit("timeupdate");
  };

  private onMediaTimeUpdate = () => {
    // Covers seeks and the paused state; playback-time smoothness comes
    // from the rAF loop.
    this.emit("timeupdate");
  };
}
