// Встроенный бэкенд CarBUS.app: Python из Contents/Resources/python запускает
// `python -m app.desktop` (сервер на 127.0.0.1, мост выключен, уходит вместе с окном).
import Darwin
import Foundation

/// Где программа держит данные и журналы. CARBUS_HOME (только для тестов) переносит всё в одну
/// папку. Не «Документы»: подпись ad-hoc меняется с каждой сборкой, и macOS после обновления
/// заново спрашивала бы доступ к защищённой папке.
struct Paths {
    let data: URL
    let traces: URL
    let logs: URL

    static func current() -> Paths {
        let fm = FileManager.default
        if let home = ProcessInfo.processInfo.environment["CARBUS_HOME"], !home.isEmpty {
            let root = URL(fileURLWithPath: home, isDirectory: true)
            return Paths(data: root.appendingPathComponent("data"), traces: root.appendingPathComponent("traces"),
                         logs: root.appendingPathComponent("Logs"))
        }
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CarBUS")
        let library = fm.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        return Paths(data: support.appendingPathComponent("data"), traces: support.appendingPathComponent("traces"),
                     logs: library.appendingPathComponent("Logs/CarBUS"))
    }
}

/// Журнал окна (app.log): строки `backend ready port=…` и `backend exited code=…` читает
/// macos/test-app.sh.
enum Log {
    static var file: URL?

    static func write(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
        guard let file else { return }
        if let h = try? FileHandle(forWritingTo: file) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? Data(line.utf8).write(to: file)
        }
    }
}

/// Порт сервера: постоянный — хранилище WebKit (раскладка окна) привязано к адресу и переживает
/// перезапуск; занят другой программой — свободный порт от системы.
func pickPort(preferred: UInt16 = 47800) -> UInt16 {
    bind(port: preferred) ?? bind(port: 0) ?? preferred
}

/// Занять и сразу отпустить 127.0.0.1:port; nil — занят. Для port 0 — какой дала система.
private func bind(port: UInt16) -> UInt16? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let ok = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard ok == 0 else { return nil }
    var bound = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &bound) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    return UInt16(bigEndian: bound.sin_port)
}

final class Backend {
    let port: UInt16
    let paths: Paths
    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    /// Бэкенд завершился сам (упал или не смог стартовать): код выхода.
    var onExit: ((Int32) -> Void)?
    private var process: Process?
    private var stopping = false
    /// Опрос готовности — без кэша: общий кэш URLSession переживает перезапуск, и ответ прошлого
    /// запуска выдавал бы ещё не поднявшийся сервер за готовый.
    private let probe: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return URLSession(configuration: cfg)
    }()

    init(port: UInt16, paths: Paths) {
        self.port = port
        self.paths = paths
    }

    var logFile: URL { paths.logs.appendingPathComponent("backend.log") }

    func start() throws {
        let fm = FileManager.default
        for dir in [paths.data, paths.traces, paths.logs] {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        fm.createFile(atPath: logFile.path, contents: nil)       // журнал — заново на каждый запуск
        let log = try FileHandle(forWritingTo: logFile)
        let res = Bundle.main.resourceURL!
        let backend = res.appendingPathComponent("app/backend")
        let p = Process()
        p.executableURL = res.appendingPathComponent("python/bin/python3")
        // свой PID явно: убьют окно, пока Python грузится, — бэкенд увидит чужого родителя и уйдёт
        p.arguments = ["-m", "app.desktop", "--port", String(port), "--data", paths.data.path,
                       "--traces", paths.traces.path, "--exit-with-parent", String(getpid())]
        p.currentDirectoryURL = backend
        p.environment = [
            "PYTHONPATH": backend.path,
            "PYTHONDONTWRITEBYTECODE": "1",          // в пакет не пишем: .pyc собраны при сборке
            "PYTHONNOUSERSITE": "1",
            "PYTHONIOENCODING": "utf-8",
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "ru_RU.UTF-8",
        ]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                Log.write("backend exited code=\(proc.terminationStatus)")
                guard let self, !self.stopping else { return }
                self.onExit?(proc.terminationStatus)
            }
        }
        try p.run()
        process = p
        Log.write("backend started pid=\(p.processIdentifier) port=\(port)")
    }

    /// Ждать ответа сервера (GET / → 200) не дольше timeout.
    func waitReady(timeout: TimeInterval, _ done: @escaping (Bool) -> Void) {
        let t0 = Date()
        func poll() {
            var req = URLRequest(url: url)
            req.timeoutInterval = 1
            req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            probe.dataTask(with: req) { _, resp, _ in
                DispatchQueue.main.async {
                    if (resp as? HTTPURLResponse)?.statusCode == 200 {
                        Log.write(String(format: "backend ready port=\(self.port) in %.1f s", Date().timeIntervalSince(t0)))
                        done(true)
                    } else if Date().timeIntervalSince(t0) < timeout, self.process?.isRunning == true {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: poll)
                    } else {
                        done(false)
                    }
                }
            }.resume()
        }
        poll()
    }

    /// Остановить: SIGTERM, через 3 с — SIGKILL.
    func stop() {
        stopping = true
        guard let p = process, p.isRunning else { return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning, Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    /// Последние строки журнала бэкенда — для страницы ошибки.
    func logTail(_ lines: Int = 20) -> String {
        let text = (try? String(contentsOf: logFile, encoding: .utf8)) ?? ""
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
    }
}
