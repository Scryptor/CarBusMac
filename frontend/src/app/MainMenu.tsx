/** Главное меню как в десктопе: Файл · Подключиться · Поток · Отладчик · Настройки · ? */
import { store } from "../core/store";
import { t } from "../i18n/ru";
import { MenuBar, type TopMenu } from "../ui/MenuBar";
import { ui } from "./ui";

export function MainMenu() {
  const connected = store.status.value.state === "opened";
  const menus: TopMenu[] = [
    {
      label: t.menu.file,
      items: [
        { action: "saveRxList", label: t.menu.saveRxList },
        { separator: true },
        { action: "txLoad", label: t.menu.loadTx },
        { action: "txSave", label: t.menu.saveTx },
        { separator: true },
        { action: "commentsLoad", label: t.menu.loadComments },
        { action: "commentsSave", label: t.menu.saveComments },
        { separator: true },
        { action: "loadStream" },
        { action: "saveStream" },
      ],
    },
    { label: connected ? t.menu.disconnect : t.menu.connect, action: "connect" },
    { label: ui.receiveMode.value === "stream" ? t.receive.menuMonitor : t.menu.stream, action: "streamSwitch" },
    { label: t.menu.tracer, action: "tracer" },
    {
      label: t.menu.settings,
      items: [{ action: "appSettings" }, { action: "logSettings" }, { separator: true }, { action: "deviceSettings" }],
    },
    {
      label: t.menu.help,
      items: [{ action: "deviceInfo" }, { separator: true }, { action: "about" }],
    },
  ];
  return <MenuBar menus={menus} />;
}
