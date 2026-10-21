/** Состояние вида отладчика на фронте: кэш видимых строк трейса (строки живут на
 * бэкенде, адресуются позицией среди видимых), выделение таблицы, таблица ID и
 * подсветка «Найти сообщения». Ревизия трейса меняется при правке и смене фильтра ID —
 * тогда позиции сдвигаются, и кэш с выделением сбрасываются; после своей правки курсор
 * ставится на строку, которую назвал сервер. Номер трейса (gen) меняется, когда открыт
 * другой трейс, — подсветка «Найти сообщения» относилась к старому. */
import { signal } from "@preact/signals";
import { client, cmd } from "../../core/client";
import { fmtId } from "../../core/format";
import { pushToast, store } from "../../core/store";
import type { PlayerConfig, TracerIdJson, TracerRowJson } from "../../core/types";
import { t } from "../../i18n/ru";
import type { GridController } from "../../ui/grid/VirtualGrid";
import { Selection } from "../../ui/grid/selection";
import { StreamCache } from "../stream/streamCache";

export const tracerCache = new StreamCache<TracerRowJson>(200);
/** Меняется, когда в кэше появились строки или сменился трейс — таблица перерисовывается. */
export const tracerVersion = signal(0);
export const tracerSel = new Selection();
/** Меняется при смене выделения — статусбар и доступность действий. */
export const tracerSelVersion = signal(0);
export const tracerIds = signal<TracerIdJson[]>([]);
/** Ключи ID, чьи строки подсвечены «Найти сообщения». */
export const tracerFound = signal<Set<string>>(new Set());
export const tracerGrid: { ctl: GridController | null } = { ctl: null };
/** Прокрутить таблицу к строке, когда она перерисуется: после правки число строк меняется,
 * и прокрутка «сейчас» считалась бы по старому числу (исполняет TracerGrid). */
export const tracerScrollTo = signal<{ pos: number } | null>(null);
/** Почему проигрыватель сам встал на паузу (пока стоит): точка останова или принятый кадр. */
export interface TracerPause {
  reason: "bp" | "rx";
  rx: { ch: number; id: number; ext: boolean } | null;
}
export const tracerPause = signal<TracerPause | null>(null);

let rev = -1;
let dataRev = -1;
let gen = -1;
/** Курсор после своей правки, ответ на которую пришёл раньше tracer_state с её ревизией. */
let pendingCursor: { rev: number; pos: number } | null = null;

export const idKey = (r: { ch: number; id: number; ext: boolean }) => `${r.ch}:${r.id}:${r.ext ? 1 : 0}`;

/** Ревизия позиций, которую знает таблица. */
export const tracerRev = () => rev;

function setCursor(pos: number): void {
  tracerSel.click(pos);
  tracerSelVersion.value++;
  tracerScrollTo.value = { pos };
}

/** true — ревизия сменилась: строки и выделение больше не соответствуют позициям. */
export function syncTracerRev(r: number): boolean {
  if (r === rev) return false;
  rev = r;
  tracerCache.reset();
  tracerSel.clear();
  const p = pendingCursor;
  if (p && p.rev <= r) pendingCursor = null;
  if (p?.rev === r) setCursor(p.pos);
  tracerSelVersion.value++;
  return true;
}

/** Ответ правки строк: ревизия позиций после неё и строка для курсора. */
export interface CursorReply {
  rev?: number;
  pos?: number | null;
}

/** Своя правка, сдвинувшая позиции (вставка, удаление, строка ушла под фильтр ID): ответ
 * несёт ревизию, после которой позиции верны, и строку для курсора. tracer_state с этой
 * ревизией обычно приходит раньше ответа и сбрасывает выделение — тогда курсор ставим
 * сразу; иначе — когда он придёт. Правка без сдвига (ревизия та же) курсор не трогает. */
export function placeCursorAfter(r: number | undefined, pos: number | null | undefined): void {
  if (r == null || pos == null) return;
  if (r === rev) {
    if (tracerSel.focus == null) setCursor(pos);
  } else if (r > rev) {
    pendingCursor = { rev: r, pos };
  }
}

/** Другой трейс (открыт, новый, перенесён из потока) — подсветка «Найти сообщения» была про старый. */
function syncTracerGen(g: number): void {
  if (g === gen) return;
  gen = g;
  tracerFound.value = new Set();
}

/** Поменялось только содержимое строк (точка останова, комментарий, запрет): строки
 * перечитываем, выделение и курсор оставляем. */
export function syncTracerData(r: number): void {
  if (r === dataRev) return;
  dataRev = r;
  tracerCache.reset();
}

export function fetchTracerRange(first: number, last: number): void {
  const total = store.tracer.value.visible;
  tracerCache.trimAround(first, last);
  for (const p of tracerCache.missingPages(first, Math.min(last, total), total)) {
    tracerCache.markPending(p);
    const askedRev = rev;
    const askedData = dataRev;
    cmd<{ rows: TracerRowJson[]; rev: number; data_rev: number }>("tracer_rows", {
      start: p * tracerCache.pageSize,
      count: tracerCache.pageSize,
    })
      .then((d) => {
        if (d.rev === askedRev && (d.data_rev ?? askedData) === askedData && askedRev === rev && askedData === dataRev) {
          tracerCache.put(p * tracerCache.pageSize, d.rows);
          tracerVersion.value++;
        }
      })
      .catch(() => {})
      .finally(() => tracerCache.clearPending(p));
  }
}

export function fetchTracerIds(): void {
  cmd<{ ids: TracerIdJson[] }>("tracer_ids")
    .then((d) => {
      tracerIds.value = d.ids ?? [];
    })
    .catch(() => {});
}

/** Причина паузы из tracer_state / tracer_progress (её нет — пауза пользователем или не пауза). */
function pauseOf(e: Record<string, unknown>): TracerPause | null {
  const reason = e.state === "paused" ? e.reason : null;
  if (reason !== "bp" && reason !== "rx") return null;
  return { reason, rx: (e.rx as TracerPause["rx"]) ?? null };
}

client.on("tracer_state", (e) => {
  syncTracerRev(Number(e.rev));
  syncTracerData(Number(e.data_rev ?? -1));
  syncTracerGen(Number(e.gen ?? -1));
  tracerPause.value = pauseOf(e);
  fetchTracerIds();
  tracerVersion.value++;
});
client.on("tracer_progress", (e) => {
  const pos = e.pos as number | null | undefined;
  // таблица следует за текущей строкой и при шаге (F8), и при остановке в точке останова —
  // оба ставят «паузу», не «воспроизведение»
  if (pos != null && e.state !== "stopped") tracerGrid.ctl?.scrollToRow(pos);
  const pause = pauseOf(e);
  tracerPause.value = pause;
  // точку останова видно в таблице (к ней прокрутили), а встал ли он от приёма — нет
  if (pause?.reason === "rx" && pause.rx) pushToast("info", t.tracer.pausedOnRx(pause.rx.ch, fmtId(pause.rx.id, pause.rx.ext, true)));
  tracerVersion.value++;
});
client.on("hello", (e) => {
  // снапшот после (пере)подключения несёт текущую ревизию — без неё ответы
  // tracer_rows отбрасывались бы как устаревшие до первого tracer_state
  const snap = e.tracer as { rev?: number; data_rev?: number; gen?: number } | undefined;
  rev = Number(snap?.rev ?? -1);
  dataRev = Number(snap?.data_rev ?? -1);
  gen = Number(snap?.gen ?? -1);
  pendingCursor = null;
  tracerPause.value = snap ? pauseOf(snap as Record<string, unknown>) : null;
  tracerCache.reset();
  tracerSel.clear();
  tracerSelVersion.value++;
  tracerFound.value = new Set();
  fetchTracerIds(); // трейс на сервере мог смениться, пока связи не было
  tracerVersion.value++;
});

/** Что передать в `tracer_play`: позиции выделенных строк, если включено «Передавать
 * выделенные» и выделено больше одной строки (одна строка — просто курсор). */
export function selectionPayload(sel: Selection, playSelected: boolean): number[] | null {
  return playSelected && sel.size > 1 ? sel.selected() : null;
}

export function focusedRow(): TracerRowJson | null {
  const f = tracerSel.focus;
  return f != null ? tracerCache.get(f) ?? null : null;
}

/** Есть ли строка под курсором (не зависит от того, загружены ли её данные). */
export const hasCursor = () => (tracerSelVersion.value, tracerSel.focus != null);

/** Строка под курсором; если кэш только что сброшен — догружаем её. */
export async function cursorRow(): Promise<TracerRowJson | null> {
  const f = tracerSel.focus;
  if (f == null) return null;
  const cached = tracerCache.get(f);
  if (cached) return cached;
  const d = await cmd<{ rows: TracerRowJson[] }>("tracer_rows", { start: f, count: 1 });
  return d.rows?.[0] ?? null;
}

export function delayText(cfg: PlayerConfig): string {
  if (cfg.delay_mode === "fixed") return t.tracer.ms(cfg.fixed_ms);
  return cfg.max_1s ? `${t.tracer.auto}, ${t.tracer.max1sShort}` : t.tracer.auto;
}

export function destText(cfg: PlayerConfig): string {
  return cfg.dest === "monitor" ? t.tracer.toMonitor : t.tracer.toChannel(cfg.dest === "ch2" ? "2" : "1");
}
