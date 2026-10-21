/** Запись демо-гифок и скриншотов для README и docs/user-guide.md.
 *
 * Поднимает демо-бэкенд без прибора (`python -m app.demo`) с заготовленными данными
 * (комментарии, названия каналов, список передачи), ведёт установленный Google Chrome
 * по сценариям и пишет docs/screenshots/*.gif и *.png. Кадры берутся скринкастом CDP,
 * GIF собирается здесь же (gifenc): общая палитра, 10 к/с, неизменившиеся пиксели
 * прозрачны — размер растёт только с изменившейся областью экрана.
 *
 *   npm run demos                       # все сценарии
 *   npm run demos -- --only monitor,stream
 *
 * Переменные окружения: CARBUS_PYTHON — python с зависимостями бэкенда (по умолчанию
 * backend/.venv/bin/python); CARBUS_CHROME — путь к Chrome, если он не в /Applications. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright-core";
import * as gifencNs from "gifenc";
import * as pngjsNs from "pngjs";
import { diffFrame, paletteSamples, resample } from "./demo-gif";

// gifenc и pngjs — CommonJS без типов; через namespace они работают и из ESM-, и из CJS-входа.
type Rgb = number[];
const gifenc = ((gifencNs as Record<string, unknown>).quantize ? gifencNs : (gifencNs as Record<string, unknown>).default) as {
  GIFEncoder: () => { writeFrame: (index: Uint8Array, w: number, h: number, o: object) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (rgba: Uint8Array, max: number, o?: object) => Rgb[];
  applyPalette: (rgba: Uint8Array, palette: Rgb[], format?: string) => Uint8Array;
};
const PNG = ((pngjsNs as Record<string, unknown>).PNG ?? (pngjsNs as { default: { PNG: unknown } }).default.PNG) as {
  sync: { read: (b: Buffer) => { width: number; height: number; data: Buffer } };
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const PORT = Number(process.env.CARBUS_DEMO_PORT ?? 8766);
const BASE = `http://127.0.0.1:${PORT}/`;
const W = 1366;
const H = 768;
const FPS = 10;
const HOLD_MS = 1500;
const TRANSPARENT = 255;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ данные демо ---
// Ключ комментария — как у хаба: "<id десятичный>:<0|1>" (1 — 29-битный ID).
const ckey = (id: number, ext = false) => `${id}:${ext ? 1 : 0}`;
const COMMENTS: Record<string, string> = {
  [ckey(0x120)]: "ЭБУ двигателя: обороты (байт 0)",
  [ckey(0x200)]: "АКПП: положение селектора",
  [ckey(0x3fb)]: "Счётчик и статус 2-го канала",
  [ckey(0x3b0)]: "VIN, ASCII",
  [ckey(0x18daf110, true)]: "Ответ диагностики (29 бит)",
  [ckey(0x7e8)]: "Ответ ЭБУ на 7E0",
};
const NO_TRIGGER = { action: "none", delay_ms: 0, channel: 0, can_id: null, ext: false, dlc: null, data: Array<null>(8).fill(null) };
const task = (id: string, channel: number, can_id: number, data: string, period_ms: number, comment: string, trigger: object = NO_TRIGGER) => ({
  id, channel, can_id, ext: false, rtr: false, data, period_ms, comment, running: false, count: 0, trigger,
});
const TASKS = [
  task("t1", 1, 0x7e0, "0210030000000000", 100, "Диагностическая сессия (UDS 10 03)"),
  task("t2", 1, 0x7e0, "023e000000000000", 2000, "TesterPresent каждые 2 с"),
  // триггер: пришёл 7E8 с байтом 1 = 50 (положительный ответ на 10) → один раз послать запрос VIN
  task("t3", 1, 0x7e0, "0322f19000000000", 100, "Запрос VIN после ответа на сессию", {
    action: "single", delay_ms: 50, channel: 1, can_id: 0x7e8, ext: false, dlc: null, data: [null, 0x50, null, null, null, null, null, null],
  }),
  task("t4", 2, 0x2a0, "0001000000000000", 100, "Пример: эмуляция кнопки"),
];
const channel = (n: number, alias: string) => ({ channel: n, alias, bitrate: 500000, timing: null, listen_only: false, terminator: false, auto_open: true });
const CONNECTION = { bridge_host: "host.docker.internal", bridge_port: 7000, channels: [channel(1, "Двигатель"), channel(2, "Кузов")] };

async function seed(dataDir: string): Promise<void> {
  await mkdir(path.join(dataDir, "lists"), { recursive: true });
  const put = (name: string, data: unknown) => writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(data, null, 1), "utf8");
  await put("settings", { theme: "light" });
  await put("connection", CONNECTION);
  await put("comments", COMMENTS);
  await put("transmit", TASKS);
}

// ------------------------------------------------------------------ бэкенд ---
async function startBackend(dataDir: string, tracesDir: string): Promise<ChildProcess> {
  const python = process.env.CARBUS_PYTHON ?? path.join(ROOT, "backend", ".venv", "bin", "python");
  const proc = spawn(python, ["-m", "app.demo", "--port", String(PORT), "--data", dataDir, "--traces", tracesDir], {
    cwd: path.join(ROOT, "backend"),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`демо-бэкенд завершился с кодом ${proc.exitCode} (python: ${python})`);
    try {
      if ((await fetch(BASE)).ok) return proc;
    } catch {
      /* ещё не слушает */
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error("демо-бэкенд не ответил за 20 с");
}

async function stopBackend(proc: ChildProcess): Promise<void> {
  if (proc.exitCode != null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill("SIGTERM");
  await Promise.race([exited, sleep(5000).then(() => proc.kill("SIGKILL"))]);
}

// ------------------------------------------------------------------ браузер ---
/** Курсор и «кольцо» клика рисуются в самой странице — скринкаст курсор не снимает. */
const CURSOR_SCRIPT = `(() => {
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="28" viewBox="0 0 20 28">'
    + '<path d="M2 1 L2 22 L7.5 17 L11 26 L14.5 24.5 L11 15.5 L18 15.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  const cur = document.createElement("div");
  cur.id = "__demo_cursor";
  cur.style.cssText = "position:fixed;left:-60px;top:-60px;width:20px;height:28px;pointer-events:none;z-index:2147483647;"
    + "transform:translate(-2px,-1px);background:url(\\"data:image/svg+xml," + svg + "\\") no-repeat;";
  const ring = document.createElement("div");
  ring.id = "__demo_ring";
  ring.style.cssText = "position:fixed;left:-60px;top:-60px;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;"
    + "border:3px solid #2f6fd6;pointer-events:none;z-index:2147483646;opacity:0;";
  const add = () => { document.body.appendChild(ring); document.body.appendChild(cur); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
  window.addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
  window.addEventListener("mousedown", (e) => {
    ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px";
    ring.style.transition = "none"; ring.style.opacity = "0.9"; ring.style.transform = "scale(.5)";
    void ring.offsetWidth;
    ring.style.transition = "opacity .45s, transform .45s"; ring.style.opacity = "0"; ring.style.transform = "scale(1.5)";
  }, true);
})();`;

async function launch(): Promise<Browser> {
  const exe = process.env.CARBUS_CHROME;
  try {
    return await chromium.launch(exe ? { executablePath: exe, headless: true } : { channel: "chrome", headless: true });
  } catch (e) {
    throw new Error(`Не удалось запустить Google Chrome (нужен установленный Chrome или CARBUS_CHROME=/путь): ${(e as Error).message}`);
  }
}

async function openPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
  await ctx.addInitScript(CURSOR_SCRIPT);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("ошибка страницы:", e.message));
  await page.goto(BASE);
  await page.locator(".statusbar").waitFor();
  return page;
}

/** Действия сценария: плавное движение курсора, клики, клавиши, стоп-кадры. */
class Demo {
  constructor(readonly page: Page) {}

  btn(name: string): Locator {
    return this.page.getByRole("button", { name, exact: true });
  }

  /** Верхний модальный диалог. */
  dialog(): Locator {
    return this.page.locator(".dialog[role=dialog]").last();
  }

  row(grid: string, n: number): Locator {
    return this.page.locator(`[role=grid][aria-label="${grid}"] [role=row][aria-rowindex="${n}"]`);
  }

  async move(target: Locator): Promise<void> {
    const box = await target.boundingBox();
    if (!box) throw new Error(`элемент не виден: ${target}`);
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
    await sleep(220);
  }

  async click(target: Locator): Promise<void> {
    await this.move(target);
    await this.page.mouse.down();
    await sleep(60);
    await this.page.mouse.up();
    await sleep(350);
  }

  async press(key: string, after = 450): Promise<void> {
    await this.page.keyboard.press(key);
    await sleep(after);
  }

  async type(target: Locator, text: string): Promise<void> {
    await this.click(target);
    await target.fill("");
    await target.pressSequentially(text, { delay: 45 });
    await sleep(250);
  }

  async select(target: Locator, value: string): Promise<void> {
    await this.move(target);
    await target.selectOption(value);
    await sleep(350);
  }

  async wheel(target: Locator, dy: number): Promise<void> {
    await this.move(target);
    await this.page.mouse.wheel(0, dy);
    await sleep(300);
  }

  async still(name: string): Promise<void> {
    const toggle = (hidden: boolean) =>
      this.page.evaluate((h) => {
        for (const id of ["__demo_cursor", "__demo_ring"]) {
          const el = document.getElementById(id);
          if (el) el.style.visibility = h ? "hidden" : "";
        }
      }, hidden);
    await toggle(true);
    await this.page.screenshot({ path: path.join(OUT, name) });
    await toggle(false);
  }

  /** Подключение без анимации — подготовка сценариев, которые начинаются уже на шине. */
  async connect(): Promise<void> {
    await this.btn("Подключиться").click();
    await this.dialog().getByRole("button", { name: "Принять" }).click();
    await this.page.locator(".statusbar", { hasText: "Подключено" }).waitFor();
  }

  /** Закрыть верхний диалог его кнопкой — так в гифке видно, чем закрыли окно. */
  async closeDialog(): Promise<void> {
    // у диалогов без «Принять» кнопок «Закрыть» две (крестик и в подвале) — хватит первой
    await this.dialog().getByRole("button", { name: "Закрыть", exact: true }).first().click();
    await sleep(300);
  }

  async closeFloats(): Promise<void> {
    const close = this.page.locator(".float").getByRole("button", { name: "Закрыть" });
    while ((await close.count()) > 0) await close.first().click();
  }
}

// ------------------------------------------------------------------ скринкаст и GIF ---
interface Frame {
  t: number;
  png: Buffer;
}

class Recorder {
  frames: Frame[] = [];
  private cdp!: CDPSession;

  constructor(private page: Page) {}

  async start(): Promise<void> {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (f) => {
      this.frames.push({ t: f.metadata.timestamp ?? Date.now() / 1000, png: Buffer.from(f.data, "base64") });
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: W, maxHeight: H });
  }

  async stop(): Promise<void> {
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
  }
}

function decode(png: Buffer): Uint8Array {
  const img = PNG.sync.read(png);
  if (img.width !== W || img.height !== H) throw new Error(`кадр ${img.width}×${img.height}, ожидалось ${W}×${H}`);
  return img.data;
}

/** Каждый step-й пиксель по обеим осям — для подбора палитры хватает. */
function subsample(frames: Uint8Array[], step: number): Uint8Array {
  const per = Math.ceil(W / step) * Math.ceil(H / step);
  const out = new Uint8Array(per * frames.length * 4);
  let o = 0;
  for (const rgba of frames) {
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const i = (y * W + x) * 4;
        out[o++] = rgba[i];
        out[o++] = rgba[i + 1];
        out[o++] = rgba[i + 2];
        out[o++] = 255;
      }
    }
  }
  return out;
}

function encodeGif(frames: Frame[]): Uint8Array {
  const ticks = resample(frames.map((f) => f.t), FPS, HOLD_MS);
  const used = [...new Set(ticks.map((t) => t.frame))];
  const samples = paletteSamples(used.length, 8).map((i) => decode(frames[used[i]].png));
  const palette = gifenc.quantize(subsample(samples, 2), TRANSPARENT, { format: "rgb565" });
  while (palette.length < TRANSPARENT) palette.push([0, 0, 0]);
  const global = [...palette, [0, 0, 0]]; // индекс 255 — прозрачный, applyPalette его не выдаёт
  const gif = gifenc.GIFEncoder();
  let prev: Uint8Array | null = null;
  for (const { frame, delayMs } of ticks) {
    const idx = gifenc.applyPalette(decode(frames[frame].png), palette, "rgb565");
    gif.writeFrame(prev ? diffFrame(prev, idx, TRANSPARENT) : idx, W, H, {
      palette: prev ? undefined : global,
      delay: delayMs,
      transparent: prev != null,
      transparentIndex: TRANSPARENT,
      dispose: 1,
      repeat: 0,
    });
    prev = idx;
  }
  gif.finish();
  return gif.bytes();
}

// ------------------------------------------------------------------ сценарии ---
const MON = "Приём [ Монитор ]";
const STREAM = "Приём [ Поток данных ]";
const TX = "CAN Передача";
const TRACER = "Отладчик";

interface Scenario {
  name: string;
  /** до записи: подключение и подготовка состояния */
  prepare?: (d: Demo) => Promise<void>;
  /** записывается в <name>.gif */
  run: (d: Demo) => Promise<void>;
  /** после записи: стоп-кадры для документации */
  after?: (d: Demo) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "connect",
    run: async (d) => {
      await sleep(600);
      await d.click(d.btn("Подключиться"));
      await sleep(1400);
      await d.still("connect.png");
      await d.click(d.dialog().getByRole("button", { name: "Принять" }));
      await sleep(3800);
    },
    after: async (d) => {
      await d.page.getByRole("button", { name: "Настройки", exact: true }).click();
      await d.page.getByRole("menuitem", { name: "Настройки устройства" }).click();
      await d.dialog().getByRole("button", { name: "Настроить скорости" }).first().click();
      await d.dialog().getByRole("button", { name: "Добавить", exact: true }).click();
      await d.page.locator("#br-caption").fill("Пример 33,3k");
      await d.page.locator("#br-rate").fill("33,3");
      await sleep(400);
      await d.still("bitrates.png");
      await d.closeDialog();
      await d.closeDialog();
      await d.page.getByRole("button", { name: "?", exact: true }).click();
      await d.page.getByRole("menuitem", { name: "Информация об устройстве" }).click();
      await sleep(400);
      await d.still("device-info.png");
      await d.closeDialog();
    },
  },
  {
    name: "monitor",
    prepare: async (d) => {
      await d.connect();
      await sleep(1600);
      await d.still("main.png");
    },
    run: async (d) => {
      await sleep(500);
      await d.click(d.row(MON, 1));
      await sleep(500);
      await d.press("F3", 2800);
      await d.press("Control+F3", 1300);
      await d.click(d.page.locator(".float").getByRole("button", { name: "Включить агрегатор" }));
      await sleep(3200);
    },
    after: async (d) => {
      await d.still("monitor.png");
      await d.closeFloats();
      await d.btn("Раздельный приём").click();
      await sleep(700);
      await d.still("split.png");
      await d.btn("Раздельный приём").click();
    },
  },
  {
    name: "stream",
    prepare: async (d) => {
      await d.connect();
      await sleep(1200);
    },
    run: async (d) => {
      await sleep(400);
      await d.press("F2", 900);
      await d.press("F5", 1400);
      await d.wheel(d.page.locator(`[role=grid][aria-label="${STREAM}"]`), -360);
      await sleep(700);
      await d.press("F8", 500);
      await d.type(d.dialog().getByLabel("Метка:"), "Газ");
      await d.type(d.dialog().getByLabel("Комментарий:"), "Нажата педаль газа");
      await d.click(d.dialog().getByRole("button", { name: "Установить" }));
      await sleep(700);
      await d.press("F5", 600);
      await d.click(d.btn("Список точек останова / меток"));
      await sleep(1100);
      await d.click(d.dialog().getByRole("button", { name: "К метке" }));
      await sleep(1300);
      await d.click(d.btn("Сохранить поток (трейс) в файл"));
      await sleep(1000);
      await d.click(d.dialog().getByRole("button", { name: "Сохранить" }));
      await sleep(1600);
    },
    after: async (d) => {
      await d.still("stream.png");
    },
  },
  {
    name: "transmit",
    prepare: async (d) => {
      await d.connect();
      await sleep(1300);
    },
    run: async (d) => {
      await sleep(400);
      await d.click(d.row(TX, 3)); // задача с триггером — виден его редактор
      await sleep(1600);
      await d.click(d.row(TX, 1));
      await sleep(500);
      await d.click(d.btn("Послать"));
      await sleep(2200); // в мониторе ответы 7E8, триггер задачи 3 сработал
      await d.click(d.row(TX, 4));
      await sleep(400);
      await d.click(d.btn("Старт"));
      await sleep(2600);
      await d.click(d.btn("Пауза"));
      await sleep(900);
    },
    after: async (d) => {
      await d.still("transmit.png");
    },
  },
  {
    name: "filters",
    prepare: async (d) => {
      await d.connect();
      await sleep(1300);
    },
    run: async (d) => {
      await sleep(400);
      await d.press("Control+F", 1500);
      await d.click(d.page.getByRole("tab", { name: "Фильтр Диапазон" }));
      await sleep(700);
      await d.click(d.btn("Добавить диапазон"));
      await sleep(600);
      await d.type(d.page.locator("#rg-from"), "100");
      await d.type(d.page.locator("#rg-to"), "2FF");
      await d.click(d.dialog().getByRole("button", { name: "Установить" }));
      await sleep(900);
      await d.press("Control+N", 2600); // монитор очищен — возвращаются только ID из диапазона
    },
    after: async (d) => {
      await d.still("filters.png");
      await d.press("Control+F", 300);
      await d.btn("Настройки фонового логирования потока").click();
      await sleep(500);
      await d.still("log-settings.png");
      await d.closeDialog();
    },
  },
  {
    name: "tracer",
    prepare: async (d) => {
      await d.connect();
      await sleep(600);
      await d.page.keyboard.press("F5");
      await sleep(3000);
      await d.page.keyboard.press("F5");
      await sleep(300);
    },
    run: async (d) => {
      await sleep(400);
      await d.press("Control+F12", 2000);
      await d.click(d.page.getByRole("button", { name: /^Точка назначения передачи/ }));
      await sleep(500);
      await d.click(d.page.getByRole("menuitemcheckbox", { name: "В монитор" }));
      await sleep(700);
      await d.click(d.page.getByRole("button", { name: /^Пауза между отправкой сообщений/ }));
      await sleep(500);
      await d.click(d.page.getByRole("menuitemcheckbox", { name: "Пауза 50 мс" }));
      await sleep(600);
      await d.click(d.row(TRACER, 22));
      await sleep(400);
      await d.press("F5", 900); // точка останова
      await d.press("F9", 2600); // воспроизведение до точки
      await d.press("F8", 700); // шаг
      await d.press("F8", 900);
    },
    after: async (d) => {
      await d.still("tracer.png");
    },
  },
  {
    name: "settings",
    prepare: async (d) => {
      await d.connect();
      await sleep(1300);
    },
    run: async (d) => {
      await sleep(400);
      await d.click(d.page.getByRole("button", { name: "Настройки", exact: true }));
      await sleep(700);
      await d.click(d.page.getByRole("menuitem", { name: "Настройки приложения" }));
      await sleep(1100);
      await d.select(d.page.locator("#st-theme"), "dark");
      await sleep(1500);
      await d.click(d.page.getByRole("tab", { name: "Шрифт в таблицах" }));
      await sleep(700);
      await d.select(d.page.locator("#st-size"), "15");
      await sleep(1300);
      await d.click(d.page.getByRole("tab", { name: "Приём данных" }));
      await sleep(1000);
      await d.click(d.dialog().getByRole("button", { name: "Принять" }));
      await sleep(2200);
    },
    after: async (d) => {
      await d.still("settings-dark.png");
    },
  },
];

// ------------------------------------------------------------------ запуск ---
function onlyNames(argv: string[]): Set<string> | null {
  const i = argv.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (i < 0) return null;
  const v = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  return new Set((v ?? "").split(",").filter(Boolean));
}

async function main(): Promise<void> {
  const only = onlyNames(process.argv);
  const list = SCENARIOS.filter((s) => !only || only.has(s.name));
  if (!list.length) throw new Error(`нет таких сценариев; есть: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  await mkdir(OUT, { recursive: true });
  const browser = await launch();
  const failed: string[] = [];
  try {
    for (const sc of list) {
      const t0 = Date.now();
      const tmp = await mkdtemp(path.join(tmpdir(), "carbus-demo-"));
      const dataDir = path.join(tmp, "data");
      const tracesDir = path.join(tmp, "traces");
      await seed(dataDir);
      await mkdir(tracesDir, { recursive: true });
      const backend = await startBackend(dataDir, tracesDir);
      let page: Page | undefined;
      try {
        page = await openPage(browser);
        const d = new Demo(page);
        await sc.prepare?.(d);
        const rec = new Recorder(page);
        await rec.start();
        await sleep(400);
        await sc.run(d);
        await sleep(200);
        await rec.stop();
        await sc.after?.(d);
        const bytes = encodeGif(rec.frames);
        await writeFile(path.join(OUT, `${sc.name}.gif`), bytes);
        console.log(`${sc.name}.gif: ${rec.frames.length} кадров скринкаста → ${(bytes.length / 1048576).toFixed(2)} МБ за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      } catch (e) {
        // один сломанный сценарий не мешает остальным; состояние страницы — в скриншоте
        failed.push(sc.name);
        const shot = path.join(tmpdir(), `carbus-demo-${sc.name}-fail.png`);
        await page?.screenshot({ path: shot }).catch(() => {});
        console.error(`✗ ${sc.name}: ${e instanceof Error ? e.message.split("\n")[0] : e}\n  скриншот: ${shot}`);
      } finally {
        await page?.context().close().catch(() => {});
        await stopBackend(backend);
        await rm(tmp, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
  if (failed.length) throw new Error(`не записаны: ${failed.join(", ")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
