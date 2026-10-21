/** Подключение потока к каркасу: таблица в области приёма и кнопки записи/файлов. */
import { ToolButton, ToolSep } from "../../ui/Toolbar";
import { extraMainButtons } from "../monitor/register";
import { receiveSlots } from "../monitor/ReceiveArea";
import { store } from "../../core/store";
import { registerStreamActions } from "./actions";
import { StreamPanel } from "./StreamGrid";

function StreamButtons() {
  const rec = store.capture.value.recording;
  return (
    <>
      <ToolSep />
      <ToolButton action="record" class={rec ? "rec-on" : undefined} />
      <ToolButton action="marker" />
      <ToolButton action="markers" />
      <ToolButton action="loadStream" />
      <ToolButton action="saveStream" />
      <ToolButton action="toTracer" />
    </>
  );
}

export function registerStream(): void {
  registerStreamActions();
  receiveSlots.stream = () => <StreamPanel />;
  extraMainButtons.push(() => <StreamButtons />);
}
