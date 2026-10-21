/** Действия главного окна, не привязанные к конкретной панели: подключение, переключение
 * видов и панелей, справка. Действия панелей регистрируют сами панели (features/*). */
import { Bug, Cable, Filter, Info, PanelBottom, Rows3, Settings2 } from "lucide-preact";
import { h } from "preact";
import type { Action } from "../core/actions";
import { cmd } from "../core/client";
import { pushToast, store } from "../core/store";
import { t } from "../i18n/ru";
import { openMenuBelow } from "../ui/ContextMenu";
import { Dialog } from "../ui/Dialog";
import { toolbarHooks } from "./MainToolbar";
import { closeDialog, openDialog, ui } from "./ui";

export const isConnected = () => store.status.value.state === "opened";

/** Подпись кнопки и пункта меню подключения — по тому, что сделает клик: при открытом
 * соединении — отключиться, во время соединения — прервать его. */
export function connectLabel(): string {
  const state = store.status.value.state;
  if (state === "opened") return t.menu.disconnect;
  if (state === "opening") return t.ui.cancelConnect;
  return t.menu.connect;
}

/** «Подключиться» открывает «Настройки устройства» (features/device); без него — по сохранённой конфигурации. */
export const connectHooks: { openConnectDialog: (() => void) | null } = { openConnectDialog: null };

export async function toggleConnect(): Promise<void> {
  try {
    if (isConnected() || store.status.value.state === "opening") {
      await cmd("disconnect");
    } else if (connectHooks.openConnectDialog) {
      connectHooks.openConnectDialog();
    } else if (store.connection.value) {
      await cmd("connect", { config: store.connection.value });
    }
  } catch (e) {
    pushToast("error", (e as Error).message);
  }
}

function AboutDialog() {
  return h(Dialog, {
    title: t.about.title,
    onClose: closeDialog,
    width: 440,
    children: [
      h("p", { style: { margin: "0 0 8px" } }, t.about.text),
      h("p", { class: "muted", style: { margin: 0 } }, t.about.version(__APP_VERSION__)),
    ],
  });
}

export function shellActions(): Action[] {
  return [
    {
      id: "connect",
      label: t.menu.connect,
      hint: t.hint.connect,
      icon: Cable,
      scope: "global",
      checked: isConnected,
      run: toggleConnect,
    },
    {
      id: "streamSwitch",
      label: t.receive.menuStream,
      hint: t.hint.streamSwitch,
      shortcut: "F2",
      icon: Rows3,
      scope: "main",
      checked: () => ui.receiveMode.value === "stream",
      run: () => {
        ui.view.value = "main";
        ui.receiveMode.value = ui.receiveMode.value === "stream" ? "monitor" : "stream";
      },
    },
    {
      id: "tracer",
      get label() {
        return ui.view.value === "tracer" ? t.menu.closeTracer : t.menu.tracer;
      },
      get hint() {
        return ui.view.value === "tracer" ? t.menu.closeTracer : t.hint.tracer;
      },
      shortcut: "F12",
      icon: Bug,
      scope: "global",
      checked: () => ui.view.value === "tracer",
      run: () => {
        ui.view.value = ui.view.value === "tracer" ? "main" : "tracer";
      },
    },
    {
      id: "transmitDock",
      label: t.tx.tab,
      hint: t.hint.transmit,
      icon: PanelBottom,
      scope: "main",
      checked: () => ui.dockOpen.value,
      run: () => {
        ui.view.value = "main";
        ui.dockOpen.value = !ui.dockOpen.value;
      },
    },
    {
      id: "filtersPanel",
      label: t.filters.title,
      hint: t.hint.filter,
      shortcut: "Ctrl+F",
      icon: Filter,
      scope: "main",
      checked: () => ui.filtersOpen.value,
      run: () => {
        ui.filtersOpen.value = !ui.filtersOpen.value;
      },
    },
    {
      id: "channelOptions",
      label: t.hint.channelOptions,
      icon: Settings2,
      scope: "global",
      enabled: isConnected,
      run: () => {
        // основная часть сплит-кнопки открывает то же меню, что и стрелка (строит features/device)
        const owner = "split:channelOptions";
        const arrow = document.querySelector<HTMLElement>(`[data-menu-owner="${owner}"]`);
        const anchor = arrow?.closest<HTMLElement>(".tool-split") ?? arrow;
        if (anchor) openMenuBelow(anchor, toolbarHooks.channelMenu(), owner);
      },
    },
    {
      id: "about",
      label: t.menu.about,
      icon: Info,
      scope: "global",
      run: () => openDialog(h(AboutDialog, {})),
    },
  ];
}
