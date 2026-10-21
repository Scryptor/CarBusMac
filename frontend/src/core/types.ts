/** JSON-формы протокола WS v2 (зеркало backend/app/hub.py и schemas.py). */

export interface MonitorRowJson {
  ch: number;
  id: number;
  ext: boolean;
  rtr: boolean;
  fd: boolean;
  brs: boolean;
  dlc: number;
  data: string; // hex
  count: number;
  period_ms: number | null;
  changed: number; // маска изменившихся байт с прошлого тика
  stable_ms: (number | null)[];
  fc: number;
  ts: number;
}

export interface FrameRowJson {
  i: number;
  t: number; // секунды от первого кадра
  ch: number;
  dir: "rx" | "tx";
  id: number;
  ext: boolean;
  rtr: boolean;
  dlc: number;
  data: string;
  marker: { label: string; comment: string } | null;
}

export interface TracerRowJson extends FrameRowJson {
  /** позиция среди видимых строк (строки неотмеченных ID скрыты); `i` — номер в трейсе */
  pos: number;
  enabled: boolean;
  bp: boolean;
  /** «Установить начало» / «Установить конец» воспроизведения */
  start: boolean;
  finish: boolean;
  before_ms: number;
  after_ms: number;
  comment: string;
}

export interface Marker {
  index: number;
  label: string;
  comment: string;
  auto: boolean;
}

export interface Timing {
  prescaler: number;
  seg1: number;
  seg2: number;
  sjw: number;
}

export interface ChannelState {
  open: boolean;
  alias: string;
  bitrate: number | null;
  timing: Timing | null;
  listen_only: boolean;
  terminator: boolean;
  error: string | null;
}

export interface DeviceInfo {
  hardware_name?: string;
  firmware_version?: string;
  serial_int?: number;
  feature_gateway?: boolean;
  feature_isotp?: boolean;
  feature_tx_buffer?: boolean;
  feature_tx_task?: boolean;
  channel_types?: Record<string, string>;
  channel_features?: Record<string, Record<string, boolean>>;
  channel_frequencies?: Record<string, number>;
  filters_info?: { channel: number; size: number }[];
  [k: string]: unknown;
}

export interface StatusState {
  state: "closed" | "opening" | "opened" | "error";
  message: string;
  device_info: DeviceInfo | null;
  channels: Record<string, ChannelState>;
  /** прибор текущего подключения (null, пока не подключены) */
  device: DeviceEntry | null;
  /** файл фоновой записи потока, пока она идёт */
  log?: string | null;
}

/** USB-порт из списка «Настроек устройства». Бэкенд видит прибор через нативный мост на
 * маке (bridge), сам (usb: Docker на Linux с пробросом USB или бэкенд без Docker) или это
 * демо-сервер (demo). */
export interface DeviceEntry {
  /** "bridge:/dev/cu.usbmodem00000000001A1" | "usb:/dev/ttyACM0" | "demo:CAN-Hacker" */
  key: string;
  source: "bridge" | "usb" | "demo";
  /** узел порта: "/dev/cu.usbmodem00000000001A1" */
  path: string;
  /** canhacker — USB-строки CAN-Hacker; compatible — VID:PID 0483:5740 без имени (возможно,
   * CAN-Hacker с другой прошивкой); other — чужой порт (монитор, плата), подключаться нельзя */
  kind: "canhacker" | "compatible" | "other";
  /** "CAN-Hacker v3.2" | строка product | описание порта */
  title: string;
  /** серийный номер из USB-строки — тот же, что «Серийный номер» в информации об устройстве */
  serial: number | null;
  firmware: string | null;
  manufacturer: string | null;
  /** сырая USB-строка product */
  product: string | null;
  usb_serial: string | null;
  vid: number | null;
  pid: number | null;
  /** порт сейчас открыт мостом (если это мы — он же в status.device) */
  busy: boolean;
  /** можно выбрать и подключиться: не «other» или порт задан мосту через CARBUS_SERIAL */
  selectable: boolean;
}

export interface BridgeInfo {
  /** unknown — ещё не опрашивали; down — по адресу никто не слушает; foreign — отвечает не
   * мост CarBUS (старый мост, «Приёмник AirPlay» на порту 7000); off — мост не используется */
  state: "unknown" | "ok" | "down" | "foreign" | "off";
  /** "host.docker.internal:7000" */
  address: string;
  /** подробность ошибки, может быть "" */
  message: string;
  /** папка проекта на маке, из которой подняли контейнер; "" — неизвестна */
  project_dir?: string;
  /** команда для Терминала мака, запускающая мост (из project_dir или скачав проект с GitHub) */
  command?: string;
}

/** Снимок найденных приборов: событие `devices`, `hello.devices` и ответ `devices_scan`. */
export interface DevicesState {
  /** сначала выбираемые (canhacker, потом compatible), потом остальные */
  devices: DeviceEntry[];
  bridge: BridgeInfo;
  usb: { state: "ok" | "unavailable"; in_container: boolean };
  /** выбираемых нет — готовое объяснение почему (мост не запущен, прибор не подключён…); иначе "" */
  hint: string;
}

export interface ChannelConfig {
  channel: number;
  alias: string;
  bitrate: number | null;
  timing: Timing | null;
  listen_only: boolean;
  terminator: boolean;
  auto_open: boolean;
}

export interface ConnectionConfig {
  bridge_host: string;
  bridge_port: number;
  /** ключ выбранного прибора (DeviceEntry.key) или "" — единственный найденный CAN-Hacker */
  device: string;
  channels: ChannelConfig[];
}

/** Событие `connection`: сервер рассылает его после каждой команды `connect` (удачной и
 * нет) — нормализованный конфиг той же формы, что `hello.connection`. */
export interface ConnectionEvent {
  type: "connection";
  connection: ConnectionConfig;
}

export interface CustomBitrate {
  caption: string;
  bitrate: number;
  sample_pct: number;
  /** тактовая частота, для которой рассчитан тайминг */
  clock_hz: number;
  timing: Timing;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  grid_font: string;
  grid_font_size: number;
  mark_changed: boolean;
  mark_color: string;
  mark_hold_ms: number;
  aggregator: boolean;
  rare_mode: boolean;
  rare_period_ms: number;
  monitor_hex_ids: boolean;
  monitor_sort: boolean;
  monitor_group_by_channel: boolean;
  restore_tx_on_start: boolean;
  tracer_max_1s: boolean;
  copy_header: boolean;
  copy_id_hex: boolean;
  copy_data_hex: boolean;
  filter_new_active: boolean;
  filter_restore_on_start: boolean;
  filter_simple_mode: boolean;
  log_autostart: boolean;
  log_record_tx: boolean;
  log_name_mask: string;
  log_meta: { transport: string; brand: string; model: string; body: string; year: string };
}

export interface CaptureState {
  recording: boolean;
  count: number;
  duration_s: number;
  full: boolean;
  rev: number;
  markers: Marker[];
  /** из какого файла буфер (null — записан здесь): F5 после загрузки начинает новую запись */
  loaded?: string | null;
  /** есть несохранённое — записанные кадры или метки: очистку спрашиваем */
  dirty?: boolean;
}

export interface TriggerJson {
  action: "none" | "single" | "start" | "stop";
  delay_ms: number;
  channel: number;
  can_id: number | null;
  ext: boolean;
  dlc: number | null;
  data: (number | null)[];
}

export interface TxTaskJson {
  id: string;
  channel: number;
  can_id: number;
  ext: boolean;
  rtr: boolean;
  data: string;
  period_ms: number;
  comment: string;
  running: boolean;
  count: number;
  trigger: TriggerJson;
}

export interface HwSlotJson {
  channel: number;
  index: number;
  enabled: boolean;
  can_id: number;
  mask: number;
  ext: boolean;
  /** тип слота у прибора: только 11-битные ID, только 29-битные или любые */
  kind?: "std" | "ext" | "any";
}

export interface RangeExclusionJson {
  enabled: boolean;
  can_id: number;
  mask: number;
}

export interface RangeFilterJson {
  id: string;
  channel: number;
  enabled: boolean;
  start: number;
  end: number;
  exclusions: RangeExclusionJson[];
}

export interface FiltersState {
  hw: HwSlotJson[];
  hw_layout: Record<string, number>;
  ranges: RangeFilterJson[];
}

export interface PlayerConfig {
  delay_mode: "timestamp" | "fixed";
  fixed_ms: number;
  max_1s: boolean;
  loop: boolean;
  dest: "ch1" | "ch2" | "monitor";
  only_channel: number | null;
  stop_on_bp: boolean;
  stop_on_rx: boolean;
}

export interface TracerState {
  name: string | null;
  modified: boolean;
  count: number;
  /** строк видно (без неотмеченных в таблице ID) */
  visible: number;
  channels: number[];
  /** ревизия позиций строк; data_rev — ревизия их содержимого */
  rev: number;
  data_rev: number;
  state: "stopped" | "playing" | "paused";
  /** текущая строка: номер в трейсе и позиция в таблице (null — скрыта) */
  current: number | null;
  pos: number | null;
  config: PlayerConfig;
  breakpoints: { i: number; pos: number | null }[];
}

export interface TracerIdJson {
  ch: number;
  id: number;
  ext: boolean;
  count: number;
  enabled: boolean;
}

export interface FileInfo {
  name: string;
  size: number;
  mtime: number;
}
