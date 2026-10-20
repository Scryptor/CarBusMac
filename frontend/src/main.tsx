/** Точка входа: WS-клиент, стор и корневой компонент. Каркас окна — в app/App.tsx (Task 13). */
import { render } from "preact";
import { client } from "./core/client";
import { applyEvent } from "./core/store";

client.on("*", (e) => applyEvent(e));
client.connect();

function Boot() {
  return <div style={{ padding: 16, font: "13px system-ui" }}>CarBUS — загрузка интерфейса…</div>;
}

render(<Boot />, document.getElementById("app")!);
