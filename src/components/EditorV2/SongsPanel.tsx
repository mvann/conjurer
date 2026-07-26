import { useEffect, useRef, useState } from "react";
import styles from "@/styles/EditorV2.module.css";
import { trpc } from "@/src/utils/trpc";
import { Song } from "@/src/types/Song";
import { sanitize } from "@/src/utils/sanitize";
import { uploadAudioFileToServer } from "@/src/utils/uploadAudio";
import { formatDisplayName } from "@/src/components/EditorV2/formatDisplayName";
import { publishPanelInset } from "@/src/components/EditorV2/panelInsets";
import { DEMO_SONGS, IS_DEMO } from "@/src/utils/demo";

// The spell crafter always works against local data for now; the plugin/role
// integration will thread the real setting through later.
const USING_LOCAL_DATA = true;

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSelectSong: (song: Song) => void;
};

// Slide-in song library from the right: the list of songs in the database,
// with an Upload Song action at the bottom. Uploading widens the panel and
// parks the song list mostly off screen (its edge pops out on the right;
// click it to come back), revealing the upload form: the same fields as the
// main app's upload audio dialog.
export function SongsPanel({ isOpen, onClose, onSelectSong }: Props) {
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  // The docs strip shares the panels' layer and shrinks out from under
  // them; tell it how wide this panel currently is.
  useEffect(() => {
    const width = !isOpen
      ? 0
      : isUploadOpen
        ? Math.min(380, window.innerWidth * 0.92)
        : 300;
    publishPanelInset("right", width);
    return () => publishPanelInset("right", 0);
  }, [isOpen, isUploadOpen]);

  // The static demo has no backend: the library is the bundled list and
  // uploads are hidden.
  const { data: fetchedSongs, isPending } = trpc.song.listSongs.useQuery(
    { usingLocalData: USING_LOCAL_DATA },
    { refetchOnWindowFocus: false, enabled: isOpen && !IS_DEMO },
  );
  const songs = IS_DEMO ? DEMO_SONGS : fetchedSongs;
  const isLoading = !IS_DEMO && isPending;

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Consume the Escape so layers below stay open.
      event.stopImmediatePropagation();
      if (isUploadOpen) setIsUploadOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isOpen, isUploadOpen, onClose]);

  const close = () => {
    setIsUploadOpen(false);
    onClose();
  };

  return (
    <>
      {isOpen && <div className={styles.panelBackdrop} onClick={close} />}
      <aside
        className={`${styles.sidePanel} ${styles.songsPanel} ${
          isOpen ? styles.songsPanelOpen : ""
        } ${isUploadOpen ? styles.songsPanelWide : ""}`}
      >
        {isUploadOpen && (
          <button
            data-doc="song-library"
            className={`${styles.sliverCancel} ${styles.sliverCancelRight}`}
            onClick={() => setIsUploadOpen(false)}
            aria-label="Back to song list"
          />
        )}
        <div className={styles.songsTrack}>
          <UploadSongPane
            isOpen={isUploadOpen}
            onUploaded={(song) => {
              setIsUploadOpen(false);
              onSelectSong(song);
            }}
            onCancel={() => setIsUploadOpen(false)}
          />

          <div className={styles.panelColumn} data-doc="song-library">
            <div className={styles.panelSectionLabel}>Songs</div>

            {isLoading && <div className={styles.panelEmpty}>Loading…</div>}
            {!isLoading && songs?.length === 0 && (
              <div className={styles.panelEmpty}>No songs yet</div>
            )}

            <ul className={styles.songList}>
              {songs?.map((song) => (
                <li key={song.id}>
                  <button
                    data-doc="song-item"
                    className={styles.songItem}
                    onClick={() => {
                      close();
                      onSelectSong(song);
                    }}
                  >
                    <span className={styles.songName}>
                      {formatDisplayName(song.name)}
                    </span>
                    {song.artist && (
                      <span className={styles.songArtist}>{song.artist}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>

            {!IS_DEMO && (
              <button
                data-doc="upload-song"
                className={styles.addPattern}
                onClick={() => setIsUploadOpen(true)}
              >
                Upload Song
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

// The upload form: the main app's upload audio fields (MP3 file, song name,
// artist) in the house style. Local mode only for now: the file goes to the
// dev server's asset directory, then the song row is created.
function UploadSongPane({
  isOpen,
  onUploaded,
  onCancel,
}: {
  isOpen: boolean;
  onUploaded: (song: Song) => void;
  onCancel: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState("");
  const [songName, setSongName] = useState("");
  const [artistName, setArtistName] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const utils = trpc.useUtils();
  const createSong = trpc.song.createSong.useMutation();

  const canUpload = !!filename && !!songName && !!artistName && !isUploading;

  const onUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file || !canUpload) return;

    setIsUploading(true);
    try {
      const uploadFilename = `${sanitize(artistName)} - ${sanitize(songName)}.mp3`;
      await uploadAudioFileToServer(file, uploadFilename);
      const song = await createSong.mutateAsync({
        usingLocalData: USING_LOCAL_DATA,
        name: songName,
        artist: artistName,
        filename: uploadFilename,
      });
      await utils.song.listSongs.invalidate();
      setFilename("");
      setSongName("");
      setArtistName("");
      onUploaded(song);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className={styles.uploadColumn} data-doc="upload-song">
      <div className={styles.panelSectionLabel}>Upload Song</div>

      <div className={styles.uploadIntro}>
        Select an MP3 audio file from your computer to upload.
      </div>

      <button
        className={styles.fileButton}
        onClick={() => fileInputRef.current?.click()}
        disabled={!isOpen}
      >
        {filename ? "Change File" : "Choose File"}
      </button>
      {filename && <div className={styles.fileName}>{filename}</div>}
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3"
        hidden
        onChange={(event) => setFilename(event.target.files?.[0]?.name ?? "")}
      />

      <label className={styles.uploadField}>
        <span className={styles.uploadFieldLabel}>Song Name</span>
        <input
          className={styles.uploadInput}
          value={songName}
          onChange={(event) => setSongName(event.target.value)}
        />
      </label>
      <label className={styles.uploadField}>
        <span className={styles.uploadFieldLabel}>Artist</span>
        <input
          className={styles.uploadInput}
          value={artistName}
          onChange={(event) => setArtistName(event.target.value)}
        />
      </label>

      <div className={styles.panelFooter}>
        <button
          className={styles.footerCta}
          disabled={!canUpload}
          onClick={onUpload}
        >
          {isUploading ? "Uploading…" : "Upload"}
        </button>
        <button className={styles.footerCancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
