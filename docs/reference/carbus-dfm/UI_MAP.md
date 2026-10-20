# CarBUSAnalyzer — карта реального UI (восстановлена из DFM)

Источник: 65 Delphi-форм (RT_RCDATA) из `CarBUSAnalyzer.x64.unpacked.exe`,
расшифрованы в текст (`*.dfm.txt` рядом; извлекатель — `tools/dfm_extract.py`).
Это фактический интерфейс десктопа, на который ориентируется порт.

## Главное окно — `frmMain` «Car BUS Analyzer» (TFRMMAIN)

- **Верхний тулбар `tbMain`**: Connect/Disconnect · Switch channel options ·
  Gateway · Clear (Ctrl+N) · DBC manager · Stream (F2) · Tracer (F12) ·
  Transmit · Hardware CAN-Filter (Ctrl+F) · Stream logging settings.
- **Центр `pnWorkArea`** — PageControl `pcReceive`:
  - вкладка **Receive** — основной монитор (group «Receive»), встроен фрейм
    `frameReceive`;
  - вкладка **Separate receive** — поканально, скроллбокс `sbChannels`
    (фреймы `frameReceiveChannel`).
  - Тулбар монитора: Stream/Monitor switch (F2) · **View bit-map (F3)** ·
    DBC chart · View frames for message (Ctrl+F3) · **Copy to TX-List** ·
    Set comment (F4) · Split receive · **Monitor rarely changing data** ·
    **Record/Pause (F5)** · Move trace to Tracer (Ctrl+F12) ·
    **Set marker/breakpoint (F8 / авто F9)**.
- **Низ `pnTransmit`** — PageControl `pcTransmit`: **CAN Transmit** ·
  **LIN Transmit** · **LIN Response** · **FD Transmit**.
- **Право `pnFilter`**: PageControl — Range Filter · Hardware Filter ·
  Device Gateway; сверху переключатель типа фильтра.
- **`sbStatus`** — статусбар.

## Монитор приёма — `frameReceive` (TFRAMERECEIVE)

- Сетка `dgReceive: TDrawGrid` (кастомная отрисовка — колонки задаются кодом,
  не в DFM; по смыслу: CH, ID, DLC, байты данных, счётчик, период).
- Контекстное меню (точные пункты): Save RX-list · Load/Save stream data ·
  Open stream in tracer · Clear table · **View message bit-map** ·
  **Show message signals** · **Set message comment** · **Copy message to
  TX-List** · **Add message ID to filter** · Message ID in HEX ·
  **Clear protect bits** · Sort received messages · **Group by channel**.
- Таймеры `tmrQueueRead` (чтение очереди в UI), `tmrDropMarker`.

## Окно «карта бит» — `frmDetails` (TFRMDETAILS) ← сердце «смотреть, что меняется»

- Группа **« Bytes bit map »**, `pbData: TPaintBox` — рисует каждый байт как
  8 бит, колонки **x80 x40 x20 x10 x08 x04 x02 x01** + столбец «Dec byte».
- Группа **« Comment »** — `edComment` (комментарий к сообщению).
- Кнопка «always-on-top» (`bbAOT`).
- Для порта: по выбранному ID показывать матрицу бит с подсветкой изменившихся,
  десятичное значение байта, комментарий.

## Передача — `frameCANTasks` (TFRAMECANTASKS) + вкладки LIN/FD

- Конфиг кадра: `btnFillData`, флаги `29 bit`, `RTR`, редактор данных
  (`frameData8`/`frameData64` — строка из N полей-байт по 24px, см.
  TFRAMEDATA8/TFRAMEDATA64).
- Панель **Trigger**: `Trigger` (combo) · `Delay (ms)` · `Trigged action` ·
  trigger-кадр: `ID`, `DLC`, `Data1..8`, `Ch` (канал). Авто-отправка по приёму
  заданного ID+данных.
- Список задач + `TActionList alTasks`; кнопки Add / Shot / Run / Run All /
  Stop All, сохранение/загрузка списка (из описания десктопа).

## Битрейт — `TDLGBITRATE` «Manage bit rates»

- Пресеты + полный ручной тайминг: Clock frequency (MHz), Bit rate (Kbps),
  Sample-Point % (50–90), Prescaler, Seg1, Seg2, Sync.Jump Width, лимиты,
  «actual bit rate». (`carbus-lib`: `open_can_channel` пресетами или
  `open_can_channel_custom` с `CanTiming`.)

## Фильтры и трейсер

- Hardware filter (`TFRAMEHARDWAREFILTER`/`TDLGHWFILTEREDIT`): 29-bit, Enable,
  маска+код, Set; индексы канал1 0–12 / канал2 13–28.
- Range filter (`TFRAMERANGEFILTER`/`TDLGRANGEFILTEREDIT`): From/To/Exclude/Set.
- Gateway (`TFRAMEGATEWAYDEVICE`/`TDLGGATEWAYEDIT`): CAN1⇒CAN2 / CAN2⇒CAN1.
- Tracer (`TFRMTRACER`): Play/Stop/Step/Repeat, Only for Channel, To Monitor,
  задержка; строка/редактор — `TDLGTRACERROW`, `TDLGTRACERDELAY`.
- Stream-запись (`TFRMSTREAM`): Record/Pause, save/load, Monitor toggle.

## Статус порта (этап 1, ветка `build/desktop-parity`)

Сверка по формам; «сделано» значит, что элементы формы есть в вебе и проверены в
браузере на 1366×768 / 1366×650, отличия перечислены. Паритетом всего приложения это
не является — отсутствующее перечислено ниже.

| Форма десктопа | Статус | Отличия / что не сделано |
|---|---|---|
| `TFRMMAIN` главное окно | сделано | меню, тулбар с подсказками и хоткеями, приём, док передачи, панель фильтров, статусбар; нет Gateway, DBC, вкладок LIN/FD передачи |
| `TFRAMERECEIVE` монитор | сделано | колонки, подсветка, редкие данные, контекстное меню; нет «Show message signals» (DBC), «Clear protect bits» |
| `TFRAMESPLITRECEIVE` / `TFRAMERECEIVECHANNEL` | сделано | раздельный приём по каналам |
| `TFRMDETAILS` битовая карта | сделано | плавающее окно, можно несколько |
| `TDLGFRAMESVIEW` данные сообщения | сделано | нужен включённый агрегатор |
| `TFRMSTREAM` поток | сделано | вид «Поток» в окне приёма, а не отдельное окно |
| `TDLGMARKER` / `TDLGMARKERLIST` | сделано | |
| `TFRMTRANSMIT` / `TFRAMECANTASKS` / `TFRAMEBASETASKS` / `TFRAMEDATA8` | сделано | док внизу; `.tsk` десктопа читается и пишется |
| `TFRAMEFDTASKS` / `TFRAMEBASE64TASKS` / `TFRAMEDATA64` / `TFRAMEASCIIDATA64` | нет | CAN-FD |
| `TFRAMELINTRANSMIT` / `TFRAMELINRESPONSE` / `TDLGBITRATELIN` | нет | LIN (carbus-lib не умеет кадры LIN) |
| `TFRMFILTER` / `TFRAMEHARDWAREFILTER` / `TDLGHWFILTEREDIT` | сделано | набор фильтров сохраняется в наш `.json` (формат `.flt` десктопа не восстановлен) |
| `TFRAMERANGEFILTER` / `TDLGRANGEFILTEREDIT` / `TDLGRANGEFILTEREXEDIT` | сделано | |
| `TFRAMEGATEWAYDEVICE` / `TDLGGATEWAYEDIT` | нет | шлюз CAN1⇔CAN2 |
| `TDLGDEVICECONFIGURE` / `TFRAMEDEVICECHANNEL` | сделано | вместо типа устройства и COM-порта — адрес моста; каналы рядом, а не вкладками |
| `TDLGBITRATE` | сделано | только свои скорости, стандартные — из таблицы прибора |
| `TDLGDEVICEINFO` | сделано | текст как memo + «Копировать» |
| `TDLGDEVCHANSPEEDINFO`, `TFRMDEVICESTAT`, `TFRMDEVICELIST` | нет | автоопределение скорости, статистика загрузки, список устройств |
| `TFRMTRACER` / `TDLGTRACERROW` / `TDLGTRACERDELAY` | сделано | вид F12 вместо отдельного окна; нет режимов отображения времени (метка/линейное/локальное) |
| `TFRAMETRACERSIGNAL*`, `TFRMDBC*`, `TDLGNEWSIGNAL` | нет | DBC |
| `TDLGAPPSETTINGS` | сделано | без опций «в отдельном окне», «поверх окон», «Символ завершения строки», вкладки «Обновления» |
| `TDLGLOGSETTINGS` / `TFRAMELOGCHANNELFILTER` | частично | одна конфигурация лога в папке traces; нет списка пресетов, выбора папки, бинарного лога, фильтра каналов лога |
| `TDLGCOMMENT`, `TDLGRAREPERIOD`, `TDLGABOUT` | сделано | «О программе» — свой текст |
| `TDLMSGIDEDIT` «Set frame message ID», `TDLGFHPROPERTIES` «Reopen menu properties» | нет | список «Недавно открытые» отладчика есть (10 файлов, хранится в браузере), окна его настройки нет |
| `TFRMBRUTEFORCECAN/LIN`, `TFRMJSENGINECONSOLE`, `TFRMESEDITOR`, `TDLGUDSSAVE`, `TDLGLICENSE` | нет | Bomber, JS, UDS, лицензия |
| `TFRMMAINADV`, `TFRMHIDDEN`, `TDMBASE` | — | служебные формы десктопа |
