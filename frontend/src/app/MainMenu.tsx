/** Главное меню как в десктопе: Файл · Подключиться · Поток · Отладчик · Настройки · ?
 * В виде отладчика вместо «Файл» и «Поток» — меню отладчика «Трейс» и «Комментарий». */
import { t } from "../i18n/ru";
import { MenuBar, type TopMenu } from "../ui/MenuBar";
import { connectLabel } from "./shellActions";
import { ui } from "./ui";

/** Меню вида отладчика («Трейс», «Комментарий») — их строит features/tracer. */
export const menuHooks: { tracer: () => TopMenu[] } = { tracer: () => [] };

export function MainMenu() {
  const tracerView = ui.view.value === "tracer";
  const viewMenus: TopMenu[] = tracerView
    ? menuHooks.tracer()
    : [
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
  ];
  const menus: TopMenu[] = [
    ...viewMenus,
    { label: connectLabel(), action: "connect" },
    ...(tracerView
      ? []
      : [{ label: ui.receiveMode.value === "stream" ? t.receive.menuMonitor : t.menu.stream, action: "streamSwitch" }]),
    { label: tracerView ? t.menu.closeTracer : t.menu.tracer, action: "tracer" },
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
