/** Тулбар главного окна: общая часть (подключение, опции каналов, виды, панели) и
 * кнопки активного вида — приёма (монитор/поток) или отладчика. */
import type { ComponentChildren } from "preact";
import { cmd } from "../core/client";
import { pushToast, store } from "../core/store";
import { t } from "../i18n/ru";
import type { MenuItem } from "../ui/Menu";
import { ToolButton, ToolSep, ToolSplit } from "../ui/Toolbar";
import { runAction } from "../core/actions";
import { ui } from "./ui";

/** Кнопки вида, который сейчас открыт (регистрируют фичи: монитор/поток, отладчик). */
export const viewToolbars: { main: (() => ComponentChildren) | null; tracer: (() => ComponentChildren) | null } = {
  main: null,
  tracer: null,
};

function channelMenu(): MenuItem[] {
  const st = store.status.value;
  const items: MenuItem[] = [{ action: "deviceInfo" }, { separator: true }];
  for (const [n, ch] of Object.entries(st.channels)) {
    const feats = st.device_info?.channel_features?.[n];
    items.push({
      label: `${t.receive.channelCaption(Number(n), ch.alias)}: ${t.device.terminator}`,
      checked: ch.terminator,
      disabled: !ch.open || (feats ? !feats.terminator : false),
      run: () =>
        void cmd("channel_terminator", { channel: Number(n), enabled: !ch.terminator }).catch((e: Error) =>
          pushToast("error", e.message),
        ),
    });
  }
  items.push({ separator: true }, { label: `${t.device.dialog}…`, run: () => runAction("deviceSettings") });
  return items;
}

export function MainToolbar() {
  const connected = store.status.value.state === "opened";
  const view = ui.view.value;
  const viewBar = view === "tracer" ? viewToolbars.tracer?.() : viewToolbars.main?.();
  return (
    <div class="toolbar" role="toolbar" aria-label="Панель инструментов">
      <ToolButton action="connect" showLabel label={connected ? t.menu.disconnect : t.menu.connect} />
      <ToolSplit action="channelOptions" items={channelMenu} />
      <ToolSep />
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
