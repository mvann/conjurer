import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { action, runInAction } from "mobx";
import { useRouter } from "next/router";
import { FaCog } from "react-icons/fa";
import styles from "@/styles/EditorV2.module.css";
import { useStore } from "@/src/types/StoreContext";
import { useSaveExperience } from "@/src/hooks/experience";
import { trpc } from "@/src/utils/trpc";

// The gear pane (decision 27): a full-height panel sliding in from the
// right, holding everything that used to live in menus. Items appear
// in the main app's own menu order, grouped by unnamed hairlines.
// Items needing input (Open, New) slide a second panel out to the
// left with the dialog inside.

const SHORTCUTS: [string, string][] = [
  ["Space", "play / pause"],
  ["← / →", "scan backward / forward"],
  ["Ctrl + / -", "zoom in / out"],
  ["Cmd+S", "save"],
  ["Cmd+Shift+S", "save as"],
  ["Cmd+Z / Cmd+Shift+Z", "undo / redo"],
  ["E or Enter", "type a hovered keyframe's value"],
  ["Escape", "peel: menus, selection, editor, panels"],
  ["? or /", "the full instructions for the hovered control"],
];

export const GearPane = observer(function GearPane() {
  const store = useStore();
  const { uiStore, audioStore, experienceStore } = store;
  const router = useRouter();
  const { saveExperience } = useSaveExperience();
  const [isOpen, setIsOpen] = useState(false);
  // The slide-out sub-panel: the open browser or the shortcuts sheet.
  const [subPane, setSubPane] = useState<"open" | "shortcuts" | null>(null);

  const experienceList = trpc.experience.listExperiences.useQuery(
    { usingLocalData: store.usingLocalData },
    { enabled: isOpen && subPane === "open" },
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      if (subPane) setSubPane(null);
      else setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isOpen, subPane]);

  const item = (
    label: string,
    onClick: () => void,
    options: { active?: boolean; doc?: string } = {},
  ) => (
    <button
      key={label}
      className={`${styles.gearItem} ${
        options.active ? styles.gearItemActive : ""
      }`}
      data-doc={options.doc ?? "gear-item"}
      onClick={onClick}
    >
      {label}
    </button>
  );

  const link = (label: string, href: string) => (
    <a
      key={label}
      className={styles.gearItem}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {label}
    </a>
  );

  const separator = <div className={styles.gearSeparator} />;

  return (
    <>
      <button
        className={`${styles.gearButton} ${
          store.hasSaved ? "" : styles.gearButtonDirty
        }`}
        data-doc="gear"
        aria-label="Settings"
        onClick={() => setIsOpen(!isOpen)}
      >
        <FaCog size={14} />
      </button>

      <aside
        className={`${styles.gearPane} ${isOpen ? styles.gearPaneOpen : ""}`}
        data-doc="gear-pane"
      >
        <div className={styles.gearColumn}>
          {item("New Experience", () => {
            experienceStore.loadEmptyExperience();
            router.push("/editor", undefined, { shallow: true });
            setIsOpen(false);
          })}
          {item("Open…", () => setSubPane(subPane === "open" ? null : "open"), {
            active: subPane === "open",
            doc: "gear-open",
          })}
          {item("Save", () => {
            saveExperience();
          })}
          {item("Save As…", () =>
            runInAction(() => {
              uiStore.showingSaveExperienceModal = true;
            }),
          )}
          {separator}
          {item("Copy Experience JSON to Clipboard", () => {
            experienceStore.copyToClipboard();
          })}
          {separator}
          {item(
            `Orientation · ${uiStore.horizontalLayout ? "Horizontal" : "Vertical"}`,
            action(() => {
              uiStore.horizontalLayout = !uiStore.horizontalLayout;
            }),
            { doc: "gear-orientation" },
          )}
          {item(
            `Render Size · ${uiStore.renderTargetSize}`,
            action(() => {
              const sizes = [256, 512, 1024];
              const index = sizes.indexOf(uiStore.renderTargetSize);
              uiStore.renderTargetSize = sizes[(index + 1) % sizes.length];
            }),
          )}
          {item(
            `Display Mode · ${uiStore.displayMode}`,
            action(() => {
              const modes: ("canopy" | "cartesianSpace" | "canopySpace")[] = [
                "canopy",
                "cartesianSpace",
                "canopySpace",
              ];
              const index = modes.indexOf(
                uiStore.displayMode as (typeof modes)[number],
              );
              uiStore.displayMode = modes[(index + 1) % modes.length];
            }),
          )}
          {item(
            "Show Performance Overlay",
            action(() => uiStore.togglePerformance()),
            { active: uiStore.showingPerformance },
          )}
          {separator}
          {item(
            "Transmit Data to Canopy",
            action(() => store.toggleSendingData()),
            { active: store.sendingData },
          )}
          {item(
            `Set Audio Latency (${(audioStore.audioLatency * 1000).toFixed()} ms)`,
            action(() => {
              uiStore.showingLatencyModal = true;
            }),
          )}
          {link("Admin", "/admin")}
          {link("Playground", "/playground")}
          {separator}
          {link("About Conjurer", "https://github.com/SotSF/conjurer#conjurer")}
          {item(
            "Keyboard Shortcuts",
            () => setSubPane(subPane === "shortcuts" ? null : "shortcuts"),
            { active: subPane === "shortcuts" },
          )}
          {link("Laws of Conjury", "/laws-of-conjury")}
          {link(
            "Report an Issue",
            "https://github.com/SotSF/conjurer/issues/new/choose",
          )}
        </div>
      </aside>

      {/* The slide-out to the left of the gear pane. */}
      <aside
        className={`${styles.gearSubPane} ${
          isOpen && subPane ? styles.gearSubPaneOpen : ""
        }`}
        data-doc="gear-sub-pane"
      >
        {subPane === "open" && (
          <div className={styles.gearColumn}>
            <div className={styles.gearSubTitle}>Open Experience</div>
            {experienceList.isPending && (
              <div className={styles.gearHint}>Consulting the library…</div>
            )}
            {(experienceList.data ?? []).map((experience: any) => (
              <button
                key={experience.id}
                className={styles.gearItem}
                data-doc="gear-experience"
                onClick={() => {
                  router.push(
                    `/editor?experience=${encodeURIComponent(experience.name)}`,
                    undefined,
                    { shallow: true },
                  );
                  experienceStore.load(experience.name);
                  setSubPane(null);
                  setIsOpen(false);
                }}
              >
                {experience.name}
                {experience.user?.username
                  ? ` · ${experience.user.username}`
                  : ""}
              </button>
            ))}
            {experienceList.data && experienceList.data.length === 0 && (
              <div className={styles.gearHint}>The library is empty.</div>
            )}
          </div>
        )}
        {subPane === "shortcuts" && (
          <div className={styles.gearColumn}>
            <div className={styles.gearSubTitle}>Keyboard Shortcuts</div>
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className={styles.gearShortcutRow}>
                <span className={styles.gearShortcutKeys}>{keys}</span>
                <span>{what}</span>
              </div>
            ))}
          </div>
        )}
      </aside>
    </>
  );
});
