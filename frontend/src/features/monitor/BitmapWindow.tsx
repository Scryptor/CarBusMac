/** Окно «Детали сообщения» (frmDetails десктопа): каждый байт — 8 бит x80…x01 и
 * «Dec byte», переключившиеся биты горят «послесвечением»; комментарий к сообщению.
 * Окон можно открыть несколько — по одному на сообщение. */
import { useEffect, useMemo, useState } from "preact/hooks";
import { closeFloat, floats, openFloat } from "../../app/ui";
import { cmd } from "../../core/client";
import { fmtId, hexToBytes } from "../../core/format";
import { commentKey, pushToast, store } from "../../core/store";
import { t } from "../../i18n/ru";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { BitHistory } from "./bitHistory";
import { monitorStore } from "./MonitorGrid";
import { rowKey } from "./monitorModel";

const WEIGHTS = ["x80", "x40", "x20", "x10", "x08", "x04", "x02", "x01"];

function BitmapBody({ ch, id, ext }: { ch: number; id: number; ext: boolean }) {
  const key = rowKey(ch, id, ext);
  const hist = useMemo(() => new BitHistory(), [key]);
  const [, setTick] = useState(0);
  const row = monitorStore.get(key);
  const hold = store.settings.value.mark_hold_ms;

  useEffect(() => {
    let lastData: string | null = null;
    const sync = () => {
      const r = monitorStore.get(key);
      if (!r || r.data === lastData) return;
      lastData = r.data;
      hist.update(hexToBytes(r.data), performance.now());
      setTick((n) => n + 1);
    };
    sync();
    return monitorStore.version.subscribe(sync);
  }, [key]);

  const bytes = row ? hexToBytes(row.data) : [];
  const now = performance.now();
  const cKey = commentKey(id, ext);
  const [comment, setComment] = useState(store.comments.value[cKey] ?? "");
  const saveComment = () => {
    if ((store.comments.value[cKey] ?? "") === comment.trim()) return;
    cmd("comment_set", { id, ext, text: comment }).catch((e: Error) => pushToast("error", e.message));
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
              return (
                <span
                  key={lit ? `${pos}-${st}` : String(pos)}
                  class={`bit${on ? " on" : ""}${lit ? " chg" : ""}`}
                  style={lit ? { animationDelay: `-${Math.round(now - st)}ms` } : undefined}
                  role="cell"
                >
                  {on ? "1" : "0"}
                </span>
              );
            })}
            <span class="bm-dec mono">{b}</span>
          </div>
        ))}
        {!row ? <div class="muted bm-none">Сообщение пропало из монитора (таблица очищена)</div> : null}
      </div>
      <label class="field stack bm-comment">
        <span>{t.bitmap.comment}</span>
        <input
          class="inp"
          aria-label={t.bitmap.comment}
          value={comment}
          maxLength={200}
          onInput={(e) => setComment((e.target as HTMLInputElement).value)}
          onBlur={saveComment}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveComment();
          }}
        />
      </label>
    </div>
  );
}

export function openBitmap(ch: number, id: number, ext: boolean): void {
  const fkey = `bitmap:${rowKey(ch, id, ext)}`;
  if (floats.value.has(fkey)) return;
  const n = [...floats.value.keys()].filter((k) => k.startsWith("bitmap:")).length;
  const title = t.bitmap.caption(ch, fmtId(id, ext, true));
  openFloat(
    fkey,
    <FloatingWindow
      key={fkey}
      id={fkey}
      title={title}
      width={420}
      initial={{ x: Math.max(16, window.innerWidth - 460 - n * 28), y: 120 + n * 28 }}
      onClose={() => closeFloat(fkey)}
    >
      <BitmapBody ch={ch} id={id} ext={ext} />
    </FloatingWindow>,
  );
}
