/** Модальный диалог: Enter — «Принять», Escape — «Отмена», фокус на первое поле.
 * Окна открываются и друг над другом («Управление скоростями» поверх «Настроек
 * устройства»): клавиши и фокус принадлежат верхнему. Tab ходит по кругу внутри окна,
 * остальное приложение на это время inert, клик по подложке фокус не уводит, после
 * закрытия фокус возвращается туда, откуда окно открыли.
 * Высота ограничена окном (тело прокручивается) — на 1366×650 ничего не обрезается. */
import { signal } from "@preact/signals";
import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
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

interface Modal {
  overlay: HTMLElement;
  /** клавиша для этого окна; true — окно её обработало */
  key: (e: KeyboardEvent) => boolean;
}

/** Открытые окна снизу вверх: клавиши и фокус — у последнего. */
const stack: Modal[] = [];
const topModal = (): Modal | undefined => stack[stack.length - 1];

/** Фокус потерян (элемент с ним удалили или выключили) — клавиши всё равно достаются
 * верхнему окну. Нажатия внутри окон обрабатывают их подложки. */
function onDocumentKey(e: KeyboardEvent): void {
  const top = topModal();
  const target = e.target as Element | null;
  if (!top || target?.closest?.(".overlay, .popup")) return;
  if (top.key(e)) e.stopPropagation();
}

function pushModal(m: Modal): void {
  // родитель, смонтированный в одну отрисовку с вложенным окном, встаёт под него
  const i = stack.findIndex((o) => m.overlay.contains(o.overlay));
  if (i < 0) stack.push(m);
  else stack.splice(i, 0, m);
  if (stack.length === 1) document.addEventListener("keydown", onDocumentKey);
}

function removeModal(m: Modal): void {
  const i = stack.indexOf(m);
  if (i >= 0) stack.splice(i, 1);
  if (stack.length === 0) document.removeEventListener("keydown", onDocumentKey);
}

/** Сколько открытых окон держат элемент inert (вложенные окна делят элементы). */
const inertHolds = new Map<Element, number>();
const NOT_RENDERED = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"]);

/** Всё вокруг окна — соседи на каждом уровне от подложки до body — делаем inert: Tab,
 * клик и экранный диктор туда не попадают. Всплывающие меню и уведомления не трогаем. */
function holdInertAround(overlay: HTMLElement): () => void {
  const held: Element[] = [];
  for (let el: Element = overlay; el.parentElement && el !== document.body; el = el.parentElement) {
    for (const sib of Array.from(el.parentElement.children)) {
      if (sib === el || NOT_RENDERED.has(sib.tagName) || sib.matches(".popup, .toasts")) continue;
      const n = inertHolds.get(sib) ?? 0;
      if (n === 0) {
        if (sib.hasAttribute("inert")) continue; // inert поставил не диалог — не наш
        sib.setAttribute("inert", "");
      }
      inertHolds.set(sib, n + 1);
      held.push(sib);
    }
  }
  return () => {
    for (const sib of held) {
      const n = (inertHolds.get(sib) ?? 1) - 1;
      if (n > 0) inertHolds.set(sib, n);
      else {
        inertHolds.delete(sib);
        sib.removeAttribute("inert");
      }
    }
  };
}

/** Куда вернуть фокус после закрытия: возвращаем, когда окно уже снято с DOM. */
const restoreQueue: HTMLElement[] = [];

function takeOpener(): HTMLElement | null {
  const a = document.activeElement;
  if (a instanceof HTMLElement && a !== document.body && a.isConnected) return a;
  // окно открылось в ту же отрисовку, в которой закрылось другое (вопрос после
  // диалога): фокус вернётся туда же, куда вернулся бы от закрытого
  const i = restoreQueue.findIndex((el) => el.isConnected);
  return i >= 0 ? restoreQueue.splice(i, 1)[0] : null;
}

function restoreFocusLater(opener: HTMLElement): void {
  restoreQueue.push(opener);
  queueMicrotask(() => {
    const i = restoreQueue.indexOf(opener);
    if (i < 0) return; // его забрало новое окно
    restoreQueue.splice(i, 1);
    const a = document.activeElement;
    const lost = a == null || a === document.body || !a.isConnected;
    if (lost && opener.isConnected && !opener.closest("[inert]")) opener.focus();
  });
}

const FIRST_FIELD =
  "input:not([type=checkbox]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([readonly])";
const FOCUSABLE = "a[href], button, input, select, summary, textarea, [tabindex], [contenteditable]";
/** Содержимое свёрнутого <details> («Дополнительно») не отрисовано — видна только его summary. */
const COLLAPSED = "details:not([open]) > :not(summary)";

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      (el as HTMLInputElement).type !== "hidden" &&
      !el.closest(`[hidden], [inert], fieldset[disabled], ${COLLAPSED}`),
  );
}

/** Tab и Shift+Tab ходят по кругу внутри окна и не уводят фокус под подложку. */
function trapTab(e: KeyboardEvent, dlg: HTMLElement): void {
  const items = focusables(dlg);
  if (!items.length) {
    e.preventDefault();
    dlg.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const i = items.indexOf(active as HTMLElement);
  if (i < 0) {
    // фокус на самом окне, вне окна или на элементе вне обхода — ближайший по порядку
    e.preventDefault();
    const rel = (el: HTMLElement) => (active ? active.compareDocumentPosition(el) : Node.DOCUMENT_POSITION_FOLLOWING);
    const next = e.shiftKey
      ? [...items].reverse().find((el) => rel(el) & Node.DOCUMENT_POSITION_PRECEDING) ?? last
      : items.find((el) => rel(el) & Node.DOCUMENT_POSITION_FOLLOWING) ?? first;
    next.focus();
  } else if (e.shiftKey && i === 0) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && i === items.length - 1) {
    e.preventDefault();
    first.focus();
  }
}

/** Кнопочные input: у них Enter — своё действие. */
const BUTTON_INPUTS = new Set(["button", "submit", "reset", "file", "image", "color"]);

/** Enter нажимает «Принять» из полей ввода, флажков, списков и с самого окна. На кнопках
 * и ссылках («Скачать») он делает своё, в многострочном тексте — перенос строки. */
function enterSubmits(target: EventTarget | null, dlg: HTMLElement): boolean {
  if (target === dlg || target === document.body || target === document.documentElement) return true;
  if (target instanceof HTMLInputElement) return !BUTTON_INPUTS.has(target.type);
  return target instanceof HTMLSelectElement;
}

export function Dialog({ title, onClose, onOk, okLabel, okDisabled, cancelLabel, width, footerLeft, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const nested = useRef(false);
  const keyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  keyRef.current = (e) => {
    const dlg = ref.current;
    if (!dlg || e.defaultPrevented || e.isComposing) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return true;
    }
    if (e.key === "Enter") {
      if (!onOk || okDisabled || !enterSubmits(e.target, dlg)) return false;
      e.preventDefault();
      onOk();
      return true;
    }
    if (e.key === "Tab") {
      trapTab(e, dlg);
      return true;
    }
    return false;
  };

  useLayoutEffect(() => {
    const overlay = overlayRef.current!;
    const dlg = ref.current!;
    // до inert: inert снимает фокус с элемента, а вернуть его нужно именно туда
    const opener = takeOpener();
    nested.current = Boolean(overlay.parentElement?.closest(".overlay"));
    const modal: Modal = { overlay, key: (e) => keyRef.current(e) };
    pushModal(modal);
    const releaseInert = holdInertAround(overlay);
    modalCount.value++;
    if (topModal() === modal) {
      const first = Array.from(dlg.querySelectorAll<HTMLElement>(FIRST_FIELD)).find((el) => !el.closest(COLLAPSED));
      // без полей фокус берёт само окно — Esc/Enter работают сразу
      (first ?? dlg).focus();
      if (first instanceof HTMLInputElement) first.select();
    }
    return () => {
      modalCount.value--;
      const a = document.activeElement;
      const hadFocus = a == null || a === document.body || dlg.contains(a);
      removeModal(modal);
      releaseInert();
      if (hadFocus && opener) restoreFocusLater(opener);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      class="overlay"
      onKeyDown={(e) => {
        const top = topModal();
        const handled = top ? top.key(e) : false;
        // вложенное окно не отдаёт нажатия родительскому (у того свои Esc/Enter)
        if (handled || nested.current) e.stopPropagation();
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // клик по подложке не уводит фокус на body или в родительское окно
        e.preventDefault();
        const dlg = ref.current;
        if (dlg && !dlg.contains(document.activeElement)) dlg.focus();
      }}
    >
      <div
        ref={ref}
        class="dialog"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width: `${width}px` } : undefined}
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
