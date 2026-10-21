/** Тулбар главного окна: общая часть (подключение, опции каналов, виды, панели) и
 * кнопки активного вида — приёма (монитор/поток) или отладчика. */
import type { ComponentChildren } from "preact";
import { t } from "../i18n/ru";
import type { MenuItem } from "../ui/Menu";
import { ToolButton, ToolSep, ToolSplit } from "../ui/Toolbar";
import { connectLabel } from "./shellActions";
import { ui } from "./ui";

/** Кнопки вида, который сейчас открыт (регистрируют фичи: монитор/поток, отладчик). */
export const viewToolbars: { main: (() => ComponentChildren) | null; tracer: (() => ComponentChildren) | null } = {
  main: null,
  tracer: null,
};

/** Меню кнопки опций каналов (строит features/device). */
export const toolbarHooks: { channelMenu: () => MenuItem[] } = { channelMenu: () => [] };

export function MainToolbar() {
  const view = ui.view.value;
  const viewBar = view === "tracer" ? viewToolbars.tracer?.() : viewToolbars.main?.();
  const common = (
    <>
      <ToolButton action="connect" showLabel label={connectLabel()} />
      <ToolSplit action="channelOptions" items={() => toolbarHooks.channelMenu()} />
      <ToolSep />
    </>
  );
  if (view === "tracer") {
    // отладчик — отдельное окно в десктопе: здесь только связь с прибором и выход из вида
    return (
      <div class="toolbar" role="toolbar" aria-label={t.ui.toolbar}>
        {common}
        <ToolButton action="tracer" />
        {viewBar ? <ToolSep /> : null}
        {viewBar}
      </div>
    );
  }
  return (
    <div class="toolbar" role="toolbar" aria-label={t.ui.toolbar}>
      {common}
      <ToolButton action="clear" />
      <ToolButton action="streamSwitch" />
      <ToolButton action="tracer" />
      <ToolButton action="transmitDock" />
      <ToolButton action="filtersPanel" />
      <ToolButton action="logSettings" />
      {viewBar ? <ToolSep /> : null}
      {viewBar}
    </div>
  );
}
