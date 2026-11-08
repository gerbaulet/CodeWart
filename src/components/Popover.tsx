import { useEffect, useRef, type ReactNode } from "react";

/** Anchored popover that closes on outside click or Escape. */
export function Popover({
  open,
  onClose,
  children,
  align = "left",
  up = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "left" | "right";
  up?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const parent = ref.current?.parentElement;
      if (parent && !parent.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className="pop"
      style={{
        [align]: 0,
        ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }),
      }}
    >
      {children}
    </div>
  );
}
