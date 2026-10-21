/** Корневой компонент: меню, тулбар, рабочая область, статусбар и слои (диалоги,
 * плавающие окна, всплывающие меню, уведомления). Тема и хоткеи ставятся здесь. */
import { effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { registerActions } from "../core/actions";
import { installHotkeys } from "../core/hotkeys";
import { DEFAULT_SETTINGS, store } from "../core/store";
import { applyTheme, cachedTheme, rememberTheme } from "../core/theme";
import { ContextMenuLayer } from "../ui/ContextMenu";
import { modalCount } from "../ui/Dialog";
import { MainMenu } from "./MainMenu";
import { MainToolbar } from "./MainToolbar";
import { shellActions } from "./shellActions";
import { StatusBar } from "./StatusBar";
import { dialog, floats, ui } from "./ui";
import { Workspace } from "./Workspace";

// до первого hello настроек сервера нет (стоят значения по умолчанию): держим оформление
// из кэша браузера — его же применил index.html, иначе мелькнула бы тема «как в ОС»
effect(() => {
  const s = store.settings.value;
  if (store.helloSeq.value === 0) {
    applyTheme({ ...DEFAULT_SETTINGS, ...cachedTheme() });
    return;
  }
  applyTheme(s);
  rememberTheme(s);
});

function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {store.toasts.value.map((m) => (
        <div class={`toast ${m.level}`} role={m.level === "error" ? "alert" : "status"}>
          {m.message}
        </div>
      ))}
    </div>
  );
}

export function App() {
  useEffect(() => registerActions(shellActions()), []);
  useEffect(() => installHotkeys(() => ui.view.value, () => modalCount.value > 0), []);
  return (
    <div class="app">
      <MainMenu />
      <MainToolbar />
      <Workspace />
      <StatusBar />
      {[...floats.value.values()]}
      {dialog.value}
      <ContextMenuLayer />
      <Toasts />
    </div>
  );
}
