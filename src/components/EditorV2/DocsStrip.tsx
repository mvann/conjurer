import { useEffect, useState } from "react";
import styles from "@/styles/EditorV2.module.css";
import { getDoc } from "@/src/components/EditorV2/docs";
import {
  PANEL_INSETS_EVENT,
  panelInsets,
} from "@/src/components/EditorV2/panelInsets";

// Single-line documentation strip at the very bottom of the editor. Shows a
// how-to for whatever element the cursor is over (elements opt in via
// data-doc="<key>"; see docs.ts), sticky on the last hovered element. Read
// More opens a full-screen overlay with the long-form documentation.
export function DocsStrip() {
  const [docKey, setDocKey] = useState<string | null>(null);
  // "closing" keeps the overlay mounted while its slide-down animation
  // plays; a timer then unmounts it.
  const [overlayState, setOverlayState] = useState<"open" | "closing" | null>(
    null,
  );

  useEffect(() => {
    const onMouseOver = (event: MouseEvent) => {
      const element = (event.target as Element).closest?.("[data-doc]");
      const key = element?.getAttribute("data-doc");
      // A panel stays mounted and under the cursor while it slides shut, so
      // the pointer keeps landing on it after it is gone. Ignore anything
      // already marked hidden.
      if (key && !element?.closest('[aria-hidden="true"]')) setDocKey(key);
    };
    document.addEventListener("mouseover", onMouseOver);
    return () => document.removeEventListener("mouseover", onMouseOver);
  }, []);

  // Stickiness ends when the thing being described goes away. A panel stays
  // mounted while it slides shut and is marked aria-hidden, so without this
  // the strip would go on explaining a panel that has closed: pick a user and
  // the login panel's copy would sit there afterwards. Falling back to the
  // welcome text is the same thing an undocumented control does.
  useEffect(() => {
    if (!docKey) return;
    const stillShowing = () => {
      const element = document.querySelector(`[data-doc="${docKey}"]`);
      return !!element && !element.closest('[aria-hidden="true"]');
    };
    if (!stillShowing()) {
      setDocKey(null);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!stillShowing()) setDocKey(null);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-hidden"],
    });
    return () => observer.disconnect();
  }, [docKey]);

  // The strip lives on the side panels' layer: when one slides open the
  // strip's width squishes to the space between them instead of being
  // covered.
  const [insets, setInsets] = useState({
    left: panelInsets.left,
    right: panelInsets.right,
  });
  useEffect(() => {
    const onInsets = () =>
      setInsets({ left: panelInsets.left, right: panelInsets.right });
    window.addEventListener(PANEL_INSETS_EVENT, onInsets);
    return () => window.removeEventListener(PANEL_INSETS_EVENT, onInsets);
  }, []);

  // "?" opens/closes the overlay — a keypress, so the cursor never has to
  // leave the element being asked about. Unshifted "/" works too, since ?
  // is shift+/ on most layouts. Esc also closes. Capture phase so the
  // overlay's Escape doesn't also close the pattern editor panel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (event.key === "?" || event.key === "/") {
        setOverlayState((state) => (state === "open" ? "closing" : "open"));
      } else if (event.key === "Escape" && overlayState === "open") {
        event.stopImmediatePropagation();
        setOverlayState("closing");
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [overlayState]);

  // Unmount after the slide-down animation (0.26s). Timer-driven rather than
  // onAnimationEnd so reduced-motion (animation: none) can't strand the
  // overlay in the closing state.
  useEffect(() => {
    if (overlayState !== "closing") return;
    const timer = setTimeout(() => setOverlayState(null), 300);
    return () => clearTimeout(timer);
  }, [overlayState]);

  const doc = getDoc(docKey);

  return (
    <>
      <footer
        className={styles.docsStrip}
        data-doc="docs-strip"
        style={{ marginLeft: insets.left, marginRight: insets.right }}
      >
        <span className={styles.docsTitle}>{doc.title}</span>
        <span className={styles.docsText}>{doc.short}</span>
        <span className={styles.readMore}>Press ? for instructions</span>
      </footer>

      {overlayState !== null && (
        <div
          className={`${styles.docsOverlay} ${
            overlayState === "closing" ? styles.docsOverlayClosing : ""
          }`}
        >
          <button
            className={styles.docsOverlayClose}
            onClick={() => setOverlayState("closing")}
          >
            Close ✕
          </button>
          <div className={styles.docsOverlayContent}>
            <h2 className={styles.docsOverlayTitle}>{doc.title}</h2>
            {doc.long.split("\n\n").map((paragraph, index) => (
              <p key={index} className={styles.docsOverlayParagraph}>
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
