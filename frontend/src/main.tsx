/** Точка входа: стили, WS-клиент → стор, регистрация панелей и корневой компонент. */
import { render } from "preact";
import { App } from "./app/App";
import { client } from "./core/client";
import { applyEvent } from "./core/store";
import { registerMonitor } from "./features/monitor/register";
import { registerStream } from "./features/stream/register";
import { registerTransmit } from "./features/transmit/actions";
import { registerFilters } from "./features/filters/FiltersPanel";
import { registerDevice } from "./features/device/register";
import { registerTracer } from "./features/tracer/register";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";

client.on("*", (e) => applyEvent(e));
registerMonitor();
registerStream();
registerTransmit();
registerFilters();
registerDevice();
registerTracer();
client.connect();

render(<App />, document.getElementById("app")!);
