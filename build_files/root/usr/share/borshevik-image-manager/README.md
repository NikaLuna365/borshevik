# Borshevik Image Manager — Developer Guide

GTK4/Adwaita GUI для управления образами через `rpm-ostree`. Написано на **GJS** (JavaScript for GNOME).

---

## Стек технологий

| Компонент | Технология |
|-----------|------------|
| Язык | GJS (SpiderMonkey) — JavaScript-биндинги для GNOME |
| UI | GTK4 + libadwaita (Adw) |
| Системный бэкенд | `rpm-ostree` (CLI, JSON output) |
| Процессы | `Gio.Subprocess` |
| D-Bus | GNOME SessionManager (перезагрузка) |
| CI/CD | GitHub Actions (`gh workflow run`) |
| Пакетирование | rpm (установка в `/usr/share/borshevik-image-manager/`) |

> **Окружение запуска**: Fedora-based immutable ОС (rpm-ostree). GNOME Desktop.

---

## Структура проекта

```
borshevik/
├── .github/workflows/
│   └── promote-image-to-stable.yml   ← GitHub Actions: тегирование образа как stable
├── build_files/root/usr/share/borshevik-image-manager/
│   ├── main.js                        ← Точка входа (#!/usr/bin/env gjs)
│   ├── application.js                 ← GObject Application, инициализация i18n
│   ├── main_window.js                 ← Главное окно: статус, обновления, busy-view
│   ├── settings_window.js             ← Окно настроек: выбор варианта/канала/rebase
│   ├── app_state.js                   ← Чистые функции: buildFacts(), computeUiState()
│   ├── command_runner.js              ← Обёртка над Gio.Subprocess (chunk-based I/O)
│   ├── rpm_ostree.js                  ← Парсинг rpm-ostree JSON, вспомогательные функции
│   ├── util.js                        ← D-Bus reboot, pkexec, os-release, file helpers
│   ├── i18n.js                        ← Механизм переводов (embedded defaults + JSON)
│   └── i18n/
│       ├── en.json                    ← Английские строки (опциональные переопределения)
│       └── ru.json                    ← Русские переводы
└── CHANGES.md                         ← Документация всех изменений
```

---

## Архитектура приложения

```
┌──────────────┐
│   main.js    │  точка входа: создаёт Application, вызывает app.run()
└──────┬───────┘
       │
┌──────▼───────┐
│ application  │  GObject.registerClass(Adw.Application)
│   .js        │  инициализирует I18n, создаёт MainWindow при activate
└──────┬───────┘
       │
┌──────▼───────────────────────────────────────────────────┐
│                    main_window.js                         │
│                                                          │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────┐  │
│  │ main    │  │ busy     │  │ promote │  │ auto      │  │
│  │ view    │  │ view     │  │ menu    │  │ updates   │  │
│  │(status, │  │(progress,│  │(dynamic │  │(systemd   │  │
│  │ button) │  │ console) │  │ section)│  │ timer)    │  │
│  └─────────┘  └──────────┘  └─────────┘  └───────────┘  │
│                                                          │
│  Операции: _doUpgrade, _doRollback, _doRebase,           │
│            _onPromoteClicked, _checkForUpdates            │
└──────────────────────────────────────────────────────────┘
       │                          │
       │ emit('rebase-requested') │ CommandRunner
       │                          │
┌──────▼───────┐          ┌───────▼────────┐
│ settings_    │          │ command_       │
│ window.js    │          │ runner.js      │
│              │          │                │
│ variant/     │          │ Gio.Subprocess │
│ channel/     │          │ read_bytes_    │
│ tag picker   │          │ async(4096)    │
└──────────────┘          └───────┬────────┘
                                  │
                          ┌───────▼────────┐
                          │  rpm_ostree.js  │
                          │                 │
                          │ status --json   │
                          │ parseStatusJson │
                          │ extractDigest   │
                          │ buildTargetRef  │
                          └─────────────────┘
```

---

## Ключевые модули

### `main_window.js` (~925 строк) — ядро UI

**Два режима отображения** (Gtk.Stack):
- **main view** — статус системы, кнопка Check/Update, информация о развёртывании
- **busy view** — заголовок операции, прогресс-бар, консольный вывод (TextBuffer)

**Основные методы:**

| Метод | Назначение |
|-------|------------|
| `_refreshStatus()` | Запуск `rpm-ostree status --json`, обновление facts |
| `_checkForUpdates()` | Проверка обновлений без root |
| `_doUpgrade()` | Обновление с эскалацией через pkexec |
| `_doRollback()` | Откат + автоматический reboot prompt |
| `_doRebase(targetRef)` | Rebase на другой образ (делегирован из Settings) |
| `_onPromoteClicked()` | Promote to stable через `gh workflow run` |
| `_enterBusy(title)` / `_leaveBusy()` | Переключение в/из busy view |
| `_appendOutput(text)` | Вставка текста в TextBuffer с обработкой `\r` |
| `_tryParseChunkProgress(text)` | Парсинг `N/M chunks` → determinate progress bar |
| `_applyUiState()` | Применение `computeUiState()` к виджетам |

### `settings_window.js` (~317 строк) — настройки rebase

Не выполняет rebase сам. Эмитит сигнал `'rebase-requested'` с target ref, закрывается. MainWindow подхватывает.

### `command_runner.js` (~115 строк) — subprocess I/O

- Chunk-based чтение: `read_bytes_async(4096)` на сыром `GInputStream`
- Per-stream `TextDecoder('utf-8', { stream: true })` — корректная обработка UTF-8 на границах чанков
- Callback API: `onStdout(text)`, `onStderr(text)`, `onExit({ success, status })`
- Опциональная эскалация через `pkexec`

### `app_state.js` (~89 строк) — чистая логика

Две pure-функции:
- `buildFacts({ i18n, osRelease, parsed })` → объект с distroName, channel, buildTime и т.д.
- `computeUiState({ i18n, facts, check })` → primaryMode, primaryLabel, statusText, showCheckSpinner

### `rpm_ostree.js` (~240 строк) — интеграция с rpm-ostree

| Функция | Описание |
|---------|----------|
| `runStatusJson()` | Запуск `rpm-ostree status --json` |
| `parseStatusJson(json)` | Извлечение booted/staged/pending/rollback |
| `inferVariantAndChannelFromOrigin(origin)` | Определение variant + channel из image ref |
| `extractDigest(deployment)` | SHA256 digest из JSON deployment |
| `deriveVariantName(origin)` | `'borshevik'` или `'borshevik-nvidia'` |
| `buildTargetRef(base, channel, tag)` | Сборка target ref для rebase |

### `i18n.js` (~136 строк) — переводы

Цепочка поиска: `locale JSON → en.json → DEFAULT_STRINGS → key + console.warn`

`DEFAULT_STRINGS` встроены в код — приложение работает даже без JSON-файлов.

---

## Как запускать

```bash
# На системе с Borshevik / Fedora Atomic:
gjs build_files/root/usr/share/borshevik-image-manager/main.js

# Или, если установлено как rpm:
/usr/share/borshevik-image-manager/main.js
```

**Зависимости runtime:**
- GJS 1.76+ (GNOME 44+)
- GTK4, libadwaita
- rpm-ostree
- (опционально) `gh` CLI для promote-to-stable

---

## Паттерны, которые надо знать

### Эскалация привилегий
Все операции сначала пробуют без root. Если ответ содержит ключевые слова авторизации → повтор с `pkexec`:
```javascript
let result = await runner.run(argv, { root: false });
if (!result.success && isAuthorizationError(collected)) {
  result = await runner.run(argv, { root: true });
}
```

### GObject сигналы
Settings → MainWindow общение: `GObject.registerClass` с `Signals: { 'rebase-requested': ... }`.

### Асинхронность
GJS не имеет Node.js-стиля event loop. Все async-операции завёрнуты в промисы вручную через `*_async` / `*_finish` пары GIO API. **Никогда** не полагайся на implicit promisification GJS — она ненадёжна.

### i18n ключи
При добавлении новой строки:
1. Добавь в `DEFAULT_STRINGS` в `i18n.js` (обязательно)
2. Добавь в `en.json` (опционально, но рекомендуется)
3. Добавь перевод в `ru.json`

---

## GitHub Actions

### `promote-image-to-stable.yml`
Ручной workflow (`workflow_dispatch`). Принимает `variant` и `digest`, перетегирует образ в GHCR как `:stable` и подписывает через cosign.

Вызов из приложения:
```bash
gh workflow run promote-image-to-stable.yml \
  -R komorebinator/borshevik \
  -f variant=borshevik \
  -f digest=sha256:abc123...
```

---

## Полезные ссылки

- **CHANGES.md** — детальная документация всех изменений и ревизий
- **GHCR**: `ghcr.io/komorebinator/borshevik` / `ghcr.io/komorebinator/borshevik-nvidia`
- **GTK4 GJS docs**: https://gjs-docs.gnome.org/
- **rpm-ostree**: https://coreos.github.io/rpm-ostree/
