/** Подключение отладчика к каркасу: вид в рабочей области, его меню («Трейс»,
 * «Комментарий»), кнопки тулбара и ячейки статусбара. */
import { Send, Timer } from "lucide-preact";
import { menuHooks } from "../../app/MainMenu";
import { viewToolbars } from "../../app/MainToolbar";
import { statusHooks } from "../../app/StatusBar";
import { slots } from "../../app/Workspace";
import { ui } from "../../app/ui";
import { registerActions } from "../../core/actions";
import { store } from "../../core/store";
import { t } from "../../i18n/ru";
import type { TopMenu } from "../../ui/MenuBar";
import { ToolButton, ToolMenu, ToolSep, ToolSplit } from "../../ui/Toolbar";
import { recentItems, tracerActions } from "./actions";
import { editActions, editMenu } from "./editActions";
import { tracerMenuHooks } from "./TracerGrid";
import { delayMenuItems, destLabel, destMenuItems } from "./DelayMenu";
import { TracerView } from "./TracerView";
import {
  delayText,
  destText,
  focusedRow,
  selectionPayload,
  tracerSel,
  tracerSelVersion,
  tracerVersion,
} from "./tracerStore";

function TracerToolbar() {
  const c = store.tracer.value.config;
  tracerSelVersion.value;
  const go = selectionPayload(tracerSel, ui.tracerPlaySelected.value) ? "go-sel" : undefined;
  return (
    <>
      <ToolButton action="tracerNew" />
      <ToolSplit action="tracerOpen" items={recentItems} />
      <ToolButton action="tracerComment" />
      <ToolSep />
      <ToolButton action="tracerIds" />
      <ToolMenu id="tracer-delay" icon={Timer} label={delayText(c)} title={t.tracer.delay} items={delayMenuItems} />
      <ToolSep />
      <ToolButton action="tracerPlay" class={go} />
      <ToolButton action="tracerStop" />
      <ToolButton action="tracerStep" class={go} />
      <ToolButton action="tracerLoop" />
      <ToolButton action="tracerPlaySel" />
      <ToolMenu id="tracer-dest" icon={Send} label={destLabel(c)} title={t.tracer.dest} items={destMenuItems} />
      <ToolSep />
      <ToolButton action="tracerCopyTx" />
      <ToolSep />
      <ToolButton action="tracerBp" />
      <ToolButton action="tracerBpList" />
    </>
  );
}

function TracerStatus() {
  const st = store.tracer.value;
  tracerSelVersion.value;
  tracerVersion.value; // номер строки под курсором известен, когда её данные загружены
  const row = focusedRow();
  const picked = tracerSel.size > 1 ? tracerSel.size : 0;
  const pct = st.pos != null && st.visible > 0 ? ((st.pos + 1) / st.visible) * 100 : 0;
  return (
    <>
      <span class="cell">
        <span
          class="progress"
          role="progressbar"
          aria-label={t.tracer.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <span style={{ width: `${pct}%` }} />
        </span>
      </span>
      <span class="cell">{t.tracer.current(row ? row.i + 1 : 0, picked)}</span>
      <span class="cell">{destText(st.config)}</span>
      <span class="cell">{t.tracer.pauseStatus(delayText(st.config))}</span>
    </>
  );
}

function tracerMenus(): TopMenu[] {
  return [
    {
      label: t.tracer.trace,
      items: [
        { action: "tracerNew" },
        { action: "tracerOpen" },
        { label: t.tracer.recent, items: recentItems() },
        { separator: true },
        { action: "tracerSave" },
        { action: "tracerSaveAs" },
      ],
    },
    {
      label: t.tracer.comment,
      items: [
        { action: "commentsLoad", label: t.tracer.open },
        { action: "tracerComment" },
        { separator: true },
        { action: "commentsClear", label: t.tracer.commentClear },
      ],
    },
  ];
}

export function registerTracer(): void {
  registerActions([
    ...tracerActions(),
    ...editActions(),
    {
      id: "tracerCancelSel",
      label: t.tracer.cancelSelection,
      scope: "tracer",
      enabled: () => (tracerSelVersion.value, tracerSel.size > 0),
      run: () => {
        tracerSel.clear();
        tracerSelVersion.value++;
      },
    },
  ]);
  slots.tracer = () => <TracerView />;
  viewToolbars.tracer = () => <TracerToolbar />;
  statusHooks.tracer = () => <TracerStatus />;
  menuHooks.tracer = tracerMenus;
  tracerMenuHooks.extra = editMenu;
}
