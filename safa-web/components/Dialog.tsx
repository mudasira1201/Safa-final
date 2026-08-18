"use client";
import { useEffect, useRef, useState } from "react";

// Styled replacement for window.prompt / window.confirm.
// Renders an input when `placeholder` is set; otherwise a plain confirm.
export type DialogSpec = {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  allowEmpty?: boolean; // input dialogs: allow confirming with an empty value
  onConfirm: (value: string) => void;
};

export default function Dialog({ spec, onClose }: { spec: DialogSpec | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const hasInput = spec?.placeholder !== undefined;

  useEffect(() => {
    if (!spec) return;
    prevFocus.current = document.activeElement as HTMLElement;
    setValue(spec.defaultValue ?? "");
    const t = window.setTimeout(() => (hasInput ? inputRef.current : confirmRef.current)?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Tab" && modalRef.current) {
        const nodes = modalRef.current.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])');
        if (nodes.length === 0) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      prevFocus.current?.focus?.(); // restore focus to the element that opened the dialog
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  if (!spec) return null;
  const canConfirm = !hasInput || spec.allowEmpty || value.trim().length > 0;
  const confirm = () => { if (!canConfirm) return; spec.onConfirm(value.trim()); onClose(); };

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dlg" role="dialog" aria-modal="true" aria-label={spec.title} ref={modalRef}>
        <h3>{spec.title}</h3>
        {spec.body && <p className="msub">{spec.body}</p>}
        {hasInput && (
          <input
            ref={inputRef}
            className="dlg-input"
            value={value}
            placeholder={spec.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
          />
        )}
        <div className="dlg-actions">
          <button className="dlg-btn" onClick={onClose}>{spec.cancelLabel ?? "Cancel"}</button>
          <button
            ref={confirmRef}
            className={`dlg-btn ${spec.danger ? "danger" : "primary"}`}
            disabled={!canConfirm}
            onClick={confirm}
          >
            {spec.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}