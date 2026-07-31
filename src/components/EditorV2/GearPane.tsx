import { useState } from "react";
import { action } from "mobx";
import { observer } from "mobx-react-lite";
import { FaCog } from "react-icons/fa";
import styles from "@/styles/EditorV2.module.css";
import { useStore } from "@/src/types/StoreContext";
import type { DisplayMode } from "@/src/types/UIStore";
import { DEFAULT_EXPERIENCE_NAME } from "@/src/components/EditorV2/editorExperience";
import {
  getOrientation,
  setOrientation,
} from "@/src/components/EditorV2/orientation";

// The settings pane (decision 27): a gear left of the roles dropdown opening a
// full-height pane from the RIGHT, in the same gesture family as the songs
// panel. Anything needing input slides a SECOND panel out to its left, the way
// New Song does, rather than opening a modal over everything.
//
// The items and their order mirror the main app's MenuBar exactly — the owner
// asked for "the same order as what is in the current conjurer app" — but the
// group NAMES are dropped, as asked: unnamed hairline breaks only.
//
// Two deltas from the order the merge plan recorded, both because upstream has
// moved since: "Copy link to experience" now exists in the edit group, and
// Playground/Admin now have a real Navigate menu of their own rather than
// living beside Admin by improvisation.

type SubPanel = "new" | "open" | "saveAs" | null;

const RENDER_SIZES = [256, 512, 1024];
const DISPLAY_MODES: { value: DisplayMode; label: string }[] = [
  { value: "canopy", label: "Canopy" },
  { value: "cartesianSpace", label: "Cartesian space" },
  { value: "canopySpace", label: "Canopy space" },
];

export const GearButton = observer(function GearButton({
  isDirty,
  onOpen,
}: {
  isDirty: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className={`${styles.gearButton} ${isDirty ? styles.gearButtonDirty : ""}`}
      data-doc="gear"
      aria-label="Settings"
      onClick={onOpen}
    >
      <FaCog size={13} />
    </button>
  );
});

export const GearPane = observer(function GearPane({
  isOpen,
  onClose,
  onSave,
  onNewExperience,
  onOpenExperience,
  onSaveAs,
  experienceNames,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  onNewExperience: (name: string) => void;
  onOpenExperience: (name: string) => void;
  onSaveAs: (name: string) => void;
  experienceNames: string[];
}) {
  const store = useStore();
  const { uiStore, audioStore } = store;
  const [sub, setSub] = useState<SubPanel>(null);
  const [draftName, setDraftName] = useState("");

  const close = () => {
    setSub(null);
    setDraftName("");
    onClose();
  };

  const openSub = (which: Exclude<SubPanel, null>) => {
    setDraftName(
      which === "saveAs" && store.experienceName !== DEFAULT_EXPERIENCE_NAME
        ? store.experienceName
        : "",
    );
    setSub(which);
  };

  const item = (label: string, onClick: () => void, extra?: string) => (
    <button className={styles.gearItem} onClick={onClick} key={label}>
      <span>{label}</span>
      {extra && <span className={styles.gearItemNote}>{extra}</span>}
    </button>
  );

  const toggle = (label: string, checked: boolean, onClick: () => void) => (
    <button
      className={`${styles.gearItem} ${checked ? styles.gearItemChecked : ""}`}
      onClick={onClick}
      key={label}
      aria-pressed={checked}
    >
      <span>{label}</span>
      <span className={styles.gearCheck}>{checked ? "✓" : ""}</span>
    </button>
  );

  const link = (label: string, href: string) => (
    <a
      className={styles.gearItem}
      href={href}
      target="_blank"
      rel="noreferrer"
      key={label}
      onClick={close}
    >
      <span>{label}</span>
    </a>
  );

  const commit = () => {
    const name = draftName.trim();
    if (!name) return;
    if (sub === "new") onNewExperience(name);
    else if (sub === "saveAs") onSaveAs(name);
    close();
  };

  return (
    <>
      {isOpen && <div className={styles.panelBackdrop} onClick={close} />}

      {/* The slide-out sits to the LEFT of the pane, like New Song's does. */}
      <aside
        className={`${styles.sidePanel} ${styles.gearSubPanel} ${
          isOpen && sub ? styles.gearSubPanelOpen : ""
        }`}
        data-doc="gear-subpanel"
        aria-hidden={!(isOpen && sub)}
      >
        <div className={styles.panelColumn}>
          <div className={styles.panelSectionLabel}>
            {sub === "open"
              ? "Open experience"
              : sub === "new"
                ? "New experience"
                : sub === "saveAs"
                  ? "Save as"
                  : ""}
          </div>

          {sub === "open" ? (
            <ul className={styles.userList}>
              {experienceNames.length === 0 && (
                <div className={styles.panelEmpty}>Nothing saved yet</div>
              )}
              {experienceNames.map((name) => (
                <li key={name}>
                  <button
                    className={styles.userItem}
                    onClick={() => {
                      onOpenExperience(name);
                      close();
                    }}
                  >
                    <span className={styles.userName}>{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.newUserRow}>
              <input
                className={styles.uploadInput}
                value={draftName}
                aria-label="Experience name"
                placeholder="name"
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  commit();
                }}
              />
              <button
                className={styles.createUserButton}
                disabled={!draftName.trim()}
                onClick={commit}
              >
                {sub === "new" ? "Create" : "Save"}
              </button>
            </div>
          )}
        </div>
      </aside>

      <aside
        className={`${styles.sidePanel} ${styles.gearPane} ${
          isOpen ? styles.gearPaneOpen : ""
        }`}
        data-doc="gear-pane"
        aria-hidden={!isOpen}
      >
        <div className={styles.panelColumn}>
          {/* file */}
          {item("New experience", () => openSub("new"))}
          {item("Open…", () => openSub("open"))}
          {item("Save", onSave)}
          {item("Save as…", () => openSub("saveAs"))}

          <div className={styles.gearRule} />

          {/* edit */}
          {item("Copy experience JSON to clipboard", () => {
            store.experienceStore.copyToClipboard();
            close();
          })}
          {item("Copy link to experience", () => {
            if (typeof window !== "undefined")
              void navigator.clipboard.writeText(window.location.href);
            close();
          })}

          <div className={styles.gearRule} />

          {/* view — App orientation leads it, matching their View menu order */}
          <div className={styles.gearGroupRow}>
            <span className={styles.gearItemNote}>App orientation</span>
            <div className={styles.gearChoices}>
              {(["vertical", "horizontal"] as const).map((value) => (
                <button
                  key={value}
                  className={`${styles.gearChoice} ${
                    getOrientation() === value ? styles.gearChoiceActive : ""
                  }`}
                  onClick={() => setOrientation(value)}
                >
                  {value === "vertical" ? "Vertical" : "Horizontal"}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.gearGroupRow}>
            <span className={styles.gearItemNote}>Render size</span>
            <div className={styles.gearChoices}>
              {RENDER_SIZES.map((size) => (
                <button
                  key={size}
                  className={`${styles.gearChoice} ${
                    uiStore.renderTargetSize === size
                      ? styles.gearChoiceActive
                      : ""
                  }`}
                  onClick={action(() => (uiStore.renderTargetSize = size))}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.gearGroupRow}>
            <span className={styles.gearItemNote}>Display mode</span>
            <div className={styles.gearChoices}>
              {DISPLAY_MODES.map((mode) => (
                <button
                  key={mode.value}
                  className={`${styles.gearChoice} ${
                    uiStore.displayMode === mode.value
                      ? styles.gearChoiceActive
                      : ""
                  }`}
                  onClick={action(() => (uiStore.displayMode = mode.value))}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          {toggle("Show performance overlay", uiStore.showingPerformance, () =>
            uiStore.togglePerformance(),
          )}

          <div className={styles.gearRule} />

          {/* tools */}
          {toggle("Transmit data to canopy", store.sendingData, () =>
            store.toggleSendingData(),
          )}
          {item(
            "Set audio latency",
            action(() => {
              uiStore.showingLatencyModal = true;
              close();
            }),
            `${(audioStore.audioLatency * 1000).toFixed()}ms`,
          )}

          <div className={styles.gearRule} />

          {/* navigate */}
          {link("Playground", "/playground")}
          {link("Admin", "/admin")}

          <div className={styles.gearRule} />

          {/* help */}
          {link("About Conjurer", "https://github.com/SotSF/conjurer")}
          {item("Keyboard shortcuts", () => {
            close();
            // Spell Crafter's own help surface is the Info Strip overlay, which
            // "?" opens — the main app's shortcuts modal is local state inside
            // MenuBar and cannot be reached from here anyway. The plan puts the
            // shortcuts reference in this group; this is where it lives.
            if (typeof window !== "undefined")
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "?", bubbles: true }),
              );
          })}
          {link("Laws of Conjury", "/laws-of-conjury")}
          {link(
            "Report an issue",
            "https://github.com/SotSF/conjurer/issues/new",
          )}
        </div>
      </aside>
    </>
  );
});
