/** Модальный диалог: Enter — «Принять», Escape — «Отмена», фокус на первое поле.
 * Высота ограничена окном (тело прокручивается) — на 1366×650 ничего не обрезается. */
import { signal } from "@preact/signals";
import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { t } from "../i18n/ru";

/** Сколько модальных окон открыто — пока > 0, хоткеи главного окна молчат. */
export const modalCount = signal(0);

interface Props {
  title: string;
  onClose: () => void;
  onOk?: () => void;
  okLabel?: string;
  okDisabled?: boolean;
  cancelLabel?: string;
  width?: number;
  footerLeft?: ComponentChildren;
  children: ComponentChildren;
}

export function Dialog({ title, onClose, onOk, okLabel, okDisabled, cancelLabel, width, footerLeft, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    modalCount.value++;
    const first = ref.current?.querySelector<HTMLElement>("input:not([type=checkbox]):not([disabled]), select, textarea");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => {
      modalCount.value--;
    };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && onOk && tag !== "TEXTAREA" && tag !== "BUTTON" && !okDisabled) {
      e.preventDefault();
      e.stopPropagation();
      onOk();
    }
  };

  return (
    <div class="overlay">
      <div
        ref={ref}
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width: `${width}px` } : undefined}
        onKeyDown={onKey}
      >
        <div class="dialog-head">
          <span>{title}</span>
          <button type="button" class="icon-btn" aria-label={t.common.close} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div class="dialog-body">{children}</div>
        <div class="dialog-foot">
          {footerLeft ? <span class="left">{footerLeft}</span> : null}
          {onOk ? (
            <>
              <button type="button" class="btn" onClick={onClose}>
                {cancelLabel ?? t.common.cancel}
              </button>
              <button type="button" class="btn primary" disabled={okDisabled} onClick={onOk}>
                {okLabel ?? t.common.ok}
              </button>
            </>
          ) : (
            <button type="button" class="btn" onClick={onClose}>
              {cancelLabel ?? t.common.close}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
