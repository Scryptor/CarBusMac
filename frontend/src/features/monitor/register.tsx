/** Подключение монитора к каркасу: панель приёма, кнопки вида и действия. */
import { viewToolbars } from "../../app/MainToolbar";
import { slots } from "../../app/Workspace";
import { t } from "../../i18n/ru";
import type { MenuItem } from "../../ui/Menu";
import { ToolButton, ToolSep, ToolSplit } from "../../ui/Toolbar";
import { registerMonitorActions } from "./actions";
import { ReceiveArea, receiveSlots } from "./ReceiveArea";
import { SplitMonitor } from "./SplitMonitor";

const commentMenu = (): MenuItem[] => [
  { action: "comment" },
  { separator: true },
  { action: "commentsLoad", label: t.comment.open },
  { action: "commentsSave", label: t.comment.save },
  { separator: true },
  { action: "commentsClear" },
];

const rareMenu = (): MenuItem[] => [{ action: "rareMode" }, { action: "rarePeriod" }];

/** Дополнительные кнопки вида (поток, Task 17) добавляются сюда. */
export const extraMainButtons: (() => preact.ComponentChildren)[] = [];

function MainViewButtons() {
  return (
    <>
      <ToolButton action="bitmap" />
      <ToolButton action="frames" />
      <ToolButton action="copyToTx" />
      <ToolSplit action="comment" items={commentMenu} />
      <ToolSep />
      <ToolButton action="split" />
      <ToolSplit action="rareMode" items={rareMenu} />
      {extraMainButtons.map((f) => f())}
    </>
  );
}

export function registerMonitor(): void {
  registerMonitorActions();
  slots.receive = () => <ReceiveArea />;
  receiveSlots.split = () => <SplitMonitor />;
  viewToolbars.main = () => <MainViewButtons />;
}
