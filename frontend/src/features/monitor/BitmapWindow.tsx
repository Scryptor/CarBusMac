/** Окно «Детали сообщения» (frmDetails десктопа): каждый байт — 8 бит x80…x01 и
 * «Десятичное число», переключившиеся биты горят «послесвечением»; комментарий к сообщению.
 * Окон можно открыть несколько — по одному на сообщение монитора. В режиме «Поток» окно
 * одно и идёт за выделенной строкой потока: при переходе по кадрам того же ID подсвечиваются
 * биты, изменившиеся с прошлого показанного кадра. */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { closeFloat, floats, openFloat } from "../../app/ui";
import { cmd } from "../../core/client";
import { fmtId, hexToBytes } from "../../core/format";
import { commentKey, pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { BitHistory } from "./bitHistory";
import { phaseRef } from "./highlight";
import { streamSelection } from "../stream/StreamGrid";
import { monitorStore } from "./MonitorGrid";
import { rowKey } from "./monitorModel";

const WEIGHTS = ["x80", "x40", "x20", "x10", "x08", "x04", "x02", "x01"];

/** fixed — данные кадра (hex) вместо живой строки монитора: строка потока. */
function BitmapBody({ ch, id, ext, fixed }: { ch: number; id: number; ext: boolean; fixed?: string }) {
  const key = rowKey(ch, id, ext);
  const hist = useMemo(() => new BitHistory(), [key]);
  const [, setTick] = useState(0);
  const live = fixed === undefined;
  const row = live ? monitorStore.get(key) : null;
  const hold = store.settings.value.mark_hold_ms;

  useEffect(() => {
    if (live) return;
    hist.update(hexToBytes(fixed), performance.now());
    setTick((n) => n + 1);
  }, [key, fixed]);

  useEffect(() => {
    if (!live) return;
    let lastData: string | null = null;
    const sync = () => {
      const r = monitorStore.get(key);
      if (!r) {
        // монитор очистили — показать «Сообщение пропало», а не последние биты
        if (lastData !== null) {
          lastData = null;
          hist.reset();
          setTick((n) => n + 1);
        }
        return;
      }
      if (r.data === lastData) return;
      lastData = r.data;
      hist.update(hexToBytes(r.data), performance.now());
      setTick((n) => n + 1);
    };
    sync();
    return monitorStore.version.subscribe(sync);
  }, [key, live]);

  const data = live ? row?.data : fixed;
  const bytes = data != null ? hexToBytes(data) : [];
  const now = performance.now();
  const stored = store.comments.value[commentKey(id, ext)] ?? "";
  const [comment, setComment] = useState(stored);
  /** Поле правили и ещё не отправили. Пока правки нет, поле показывает комментарий из стора
   * (его могли сменить F4 или другая вкладка), а уход из поля ничего не шлёт — иначе
   * устаревший текст затёр бы более новый комментарий. */
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setComment(stored);
  }, [stored]);
  const saveComment = () => {
    if (!edited.current) return;
    edited.current = false;
    if (stored === comment.trim()) return;
    cmd("comment_set", { id, ext, text: comment }).catch((e: Error) => {
      edited.current = true; // не ушло — правка остаётся, Enter повторит
      pushToast("error", e.message);
    });
  };

  return (
    <div class="bitmap">
      <div class="bm-grid" role="table" aria-label={t.bitmap.group}>
        <div class="bm-row bm-head" role="row">
          <span class="bm-idx" />
          {WEIGHTS.map((w) => (
            <span class="bm-w" role="columnheader">
              {w}
            </span>
          ))}
          <span class="bm-dec">{t.bitmap.dec}</span>
        </div>
        {bytes.map((b, i) => (
          <div class="bm-row" role="row" data-byte={i}>
            <span class="bm-idx">{i}</span>
            {WEIGHTS.map((_, pos) => {
              const on = ((b >> (7 - pos)) & 1) === 1;
              const st = hist.start(i, pos);
              const lit = now - st < hold;
              // фазу «послесвечения» ставит phaseRef один раз, при создании горящего бита
              return lit ? (
                <span key={`${pos}-${st}`} class={`bit${on ? " on" : ""} chg`} data-st={st} ref={phaseRef} role="cell">
                  {on ? "1" : "0"}
                </span>
              ) : (
                <span key={String(pos)} class={`bit${on ? " on" : ""}`} role="cell">
                  {on ? "1" : "0"}
                </span>
              );
            })}
            <span class="bm-dec mono">{b}</span>
          </div>
        ))}
        {live && !row ? <div class="muted bm-none">{t.bitmap.gone}</div> : null}
      </div>
      <label class="field stack bm-comment">
        <span>{t.bitmap.comment}</span>
        <input
          class="inp"
          aria-label={t.bitmap.comment}
          value={comment}
          maxLength={200}
          onInput={(e) => {
            edited.current = true;
            setComment((e.target as HTMLInputElement).value);
          }}
          onBlur={saveComment}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveComment();
          }}
        />
      </label>
    </div>
  );
}

/** Окно потока: биты выделенной строки потока. */
function StreamBitmapBody() {
  const s = streamSelection.value;
  if (!s) return <div class="muted bm-none bm-pick">{t.bitmap.pickRow}</div>;
  return (
    <>
      <div class="muted bm-where">{t.bitmap.streamRow(s.ch, fmtId(s.id, s.ext, store.settings.value.monitor_hex_ids), s.i + 1)}</div>
      <BitmapBody key={rowKey(s.ch, s.id, s.ext)} ch={s.ch} id={s.id} ext={s.ext} fixed={s.rtr ? "" : s.data} />
    </>
  );
}

export function openStreamBitmap(): void {
  const fkey = "bitmap:stream";
  if (floats.value.has(fkey)) return;
  openFloat(
    fkey,
    <FloatingWindow
      key={fkey}
      id={fkey}
      title={t.bitmap.streamCaption}
      width={440}
      initial={{ x: Math.max(16, window.innerWidth - 460), y: 120 }}
      onClose={() => closeFloat(fkey)}
    >
      <StreamBitmapBody />
    </FloatingWindow>,
  );
}

/** Окна битовых карт встают рядом справа налево (по каскаду они закрывали бы друг друга),
 * не влезли в ширину — следующий ряд ниже. */
function tilePosition(n: number): { x: number; y: number } {
  const step = 452;
  const perRow = Math.max(1, Math.floor((window.innerWidth - 16) / step));
  return { x: Math.max(16, window.innerWidth - 460 - (n % perRow) * step), y: 120 + Math.floor(n / perRow) * 40 };
}

export function openBitmap(ch: number, id: number, ext: boolean): void {
  const fkey = `bitmap:${rowKey(ch, id, ext)}`;
  if (floats.value.has(fkey)) return;
  const n = [...floats.value.keys()].filter((k) => k.startsWith("bitmap:")).length;
  const title = t.bitmap.caption(ch, fmtId(id, ext, store.settings.value.monitor_hex_ids));
  openFloat(
    fkey,
    <FloatingWindow
      key={fkey}
      id={fkey}
      title={title}
      width={440}
      initial={tilePosition(n)}
      onClose={() => closeFloat(fkey)}
    >
      <BitmapBody ch={ch} id={id} ext={ext} />
    </FloatingWindow>,
  );
}
