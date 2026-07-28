import { useEffect, useRef, useState } from "react";
import styles from "@/styles/EditorV2.module.css";

// The roles dropdown (decision 18): shows where you are — Spell
// Crafter (alpha) — and links to the app's other faces.
const ROLES: [string, string][] = [
  ["Experience Editor", "/experience/untitled"],
  ["Playground", "/playground"],
  ["Viewer", "/viewer"],
];

export function RolesDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  return (
    <div className={styles.rolesDropdown} ref={ref}>
      <button
        className={styles.rolesButton}
        data-doc="roles"
        onClick={() => setIsOpen(!isOpen)}
      >
        Spell Crafter (alpha) ▾
      </button>
      {isOpen && (
        <div className={styles.rolesMenu}>
          {ROLES.map(([label, href]) => (
            <a key={label} className={styles.gearItem} href={href}>
              {label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
