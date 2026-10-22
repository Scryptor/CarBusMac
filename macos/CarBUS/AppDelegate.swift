// Окно CarBUS.app: интерфейс CarBUS for Mac во встроенном WebKit (движок Safari) + встроенный
// бэкенд. Встроенному WebKit самому нужно дать то, что браузер умеет сам: меню «Правка» (без него
// не работают ⌘C/⌘V), <input type=file>, скачивания, alert/confirm, внешние ссылки.
// Для проверок (macos/test-app.sh): CARBUS_SNAPSHOT=<png> — снимок содержимого окна через 3 с
// после загрузки интерфейса, CARBUS_QUIT_AFTER_SNAPSHOT=1 — затем выйти.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let env = ProcessInfo.processInfo.environment
    private let paths = Paths.current()
    private var window: NSWindow!
    private var web: WKWebView!
    private var backend: Backend?
    private var quitting = false
    private var failed = false

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        try? FileManager.default.createDirectory(at: paths.logs, withIntermediateDirectories: true)
        Log.file = paths.logs.appendingPathComponent("app.log")
        Log.write("CarBUS \(version) start")
        buildMenu()
        buildWindow()
        startBackend()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        backend?.stop()
        Log.write("CarBUS quit")
    }

    // MARK: - бэкенд

    private func startBackend() {
        failed = false
        showMessage("Запуск CarBUS…")
        let b = Backend(port: pickPort(), paths: paths)
        b.onExit = { [weak self] code in self?.backendFailed("CarBUS неожиданно остановился (код \(code)).") }
        backend = b
        do {
            try b.start()
        } catch {
            backendFailed("Не удалось запустить CarBUS: \(error.localizedDescription)")
            return
        }
        b.waitReady(timeout: 30) { [weak self] ok in
            guard let self, b === self.backend else { return }
            if ok { self.web.load(URLRequest(url: b.url)) } else { self.backendFailed("CarBUS не ответил за 30 секунд.") }
        }
    }

    private func backendFailed(_ reason: String) {
        guard !quitting, !failed else { return }
        failed = true
        Log.write("error: \(reason)")
        let log = backend?.logFile.path ?? ""
        web.loadHTMLString("""
            <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
            <body style="font:14px -apple-system;padding:32px;max-width:900px">
            <h2>\(esc(reason))</h2>
            <p><a href="carbus://retry">Запустить снова</a></p>
            <p>Если не помогает, перезапустите программу. Журнал для разработчика: <code>\(esc(log))</code></p>
            <pre style="white-space:pre-wrap;opacity:.75">\(esc(backend?.logTail() ?? ""))</pre>
            """, baseURL: nil)
    }

    private func showMessage(_ text: String) {
        web.loadHTMLString("""
            <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
            <body style="font:15px -apple-system;padding:40px;opacity:.6">\(esc(text))</body>
            """, baseURL: nil)
    }

    private func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    // MARK: - окно и меню

    private func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()             // раскладка окна (localStorage) переживает перезапуск
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = true }   // «Разработка» в Safari — для разбора проблем
        let visible = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900)
        let size = NSSize(width: min(1366, visible.width), height: min(820, visible.height - 40))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "CarBUS"
        window.contentMinSize = NSSize(width: 1024, height: 640)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("CarBUS")         // размер и место окна — как в прошлый раз
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    private func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            items.forEach { menu.addItem($0) }
            let holder = NSMenuItem()
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }
        func item(_ title: String, _ action: Selector, _ key: String = "",
                  _ mods: NSEvent.ModifierFlags = .command, mine: Bool = false) -> NSMenuItem {
            let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            if mine { it.target = self }
            return it
        }
        _ = add("CarBUS", [
            item("О программе CarBUS", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Показать трейсы в Finder", #selector(showTraces), mine: true),
            .separator(),
            item("Скрыть CarBUS", #selector(NSApplication.hide(_:)), "h"),
            item("Скрыть остальные", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Показать все", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Завершить CarBUS", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = add("Правка", [
            item("Отменить", Selector(("undo:")), "z"),
            item("Повторить", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Вырезать", #selector(NSText.cut(_:)), "x"),
            item("Копировать", #selector(NSText.copy(_:)), "c"),
            item("Вставить", #selector(NSText.paste(_:)), "v"),
            item("Выделить всё", #selector(NSText.selectAll(_:)), "a"),
        ])
        NSApp.windowsMenu = add("Окно", [
            item("Свернуть", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Изменить масштаб", #selector(NSWindow.performZoom(_:))),
            item("Во весь экран", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
            .separator(),
            item("Обновить страницу", #selector(reloadPage), "r", mine: true),
            item("Закрыть окно", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }

    @objc private func showTraces() {
        try? FileManager.default.createDirectory(at: paths.traces, withIntermediateDirectories: true)
        NSWorkspace.shared.open(paths.traces)
    }

    @objc private func reloadPage() {
        if failed { restartBackend() } else { web.reload() }
    }

    private func restartBackend() {
        backend?.stop()
        startBackend()
    }

    // MARK: - загрузка страницы и снимок для проверок

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        guard let b = backend, w.url?.port == Int(b.port), let path = env["CARBUS_SNAPSHOT"] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            w.takeSnapshot(with: nil) { img, err in
                if let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                Log.write("snapshot: \(err?.localizedDescription ?? "ok")")
                if self.env["CARBUS_QUIT_AFTER_SNAPSHOT"] != nil { NSApp.terminate(nil) }
            }
        }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        if action.request.url?.scheme == "carbus" {           // «Запустить снова» на странице ошибки
            decisionHandler(.cancel, preferences)
            restartBackend()
            return
        }
        decisionHandler(action.shouldPerformDownload ? .download : .allow, preferences)
    }

    func webView(_ w: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    // MARK: - то, что браузер умеет сам

    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = p.allowsMultipleSelection
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = m
        a.runModal()
        completionHandler()
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = m
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Отмена")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ w: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
    func webView(_ w: WKWebView, navigationResponse r: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }

    func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.url : nil) }
    }

    /// target=_blank и window.open — во внешний браузер.
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
                 windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
}
