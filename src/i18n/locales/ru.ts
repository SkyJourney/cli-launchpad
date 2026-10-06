import type { en } from "./en";

type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const ru = {
  common: {
    back: "Назад",
    browse: "Обзор",
    cancel: "Отмена",
    confirm: "Подтвердить",
    save: "Сохранить",
    copy: "Копировать",
    more: "Ещё",
    loading: "Загрузка…",
    none: "(Нет)",
  },
  sidebar: {
    projects: "Проекты",
    collapse: "Свернуть боковую панель",
    expand: "Развернуть боковую панель",
    addProject: "Добавить проект",
    searchProjects: "Поиск проектов по названию",
    projectActions: "Действия для {{name}}",
    renameProject: "Переименовать проект",
    pinProject: "Закрепить проект",
    unpinProject: "Открепить проект",
    openProjectFolder: "Открыть папку проекта",
    removeProject: "Удалить проект",
    confirmRemoveProject:
      "Удалить проект «{{name}}»? Файлы на диске не будут удалены.",
    pinProjectFailed: "Не удалось закрепить проект: {{error}}",
    reorderProjectsFailed: "Не удалось изменить порядок проектов: {{error}}",
    openProjectFolderFailed: "Не удалось открыть папку проекта: {{error}}",
    removeProjectFailed: "Не удалось удалить проект: {{error}}",
    noProjects: "Проектов пока нет. Добавьте проект, чтобы начать.",
    noMatchingProjects: "Подходящие проекты не найдены.",
    executions: "Задачи",
    settings: "Настройки",
    about: "О приложении",
    activeTasks_one: "Активная задача: {{count}}",
    activeTasks_other: "Активных задач: {{count}}",
    managedCliSessions_one: "{{tool}}, управляемая сессия: {{count}}",
    managedCliSessions_other: "{{tool}}, управляемых сессий: {{count}}",
  },
  theme: {
    current: "Тема: {{mode}}",
    select: "Выбрать тему",
    light: "Светлая",
    dark: "Тёмная",
    system: "Системная",
  },
  language: {
    current: "Язык: {{language}}",
    select: "Выбрать язык",
    zh: "简体中文",
    en: "English",
  },
  appExit: {
    title: "Выйти из CLI Launchpad?",
    description:
      "Запущено терминальных сессий: {{count}}. При выходе эти сессии и их дочерние процессы будут завершены.",
    confirm: "Завершить сессии и выйти",
    unsavedDescription: "Файлов с несохранёнными изменениями: {{count}}",
    confirmDiscard: "Отменить изменения и выйти",
    terminating: "Выход…",
  },
  windowChrome: {
    titlebar: "Строка заголовка окна приложения",
    minimize: "Свернуть",
    maximize: "Развернуть",
    restore: "Восстановить",
    close: "Закрыть окно",
  },
  pty: {
    panelLabel: "Встроенный терминал",
    paneLabel: "Область терминала",
    paneNumber: "Область {{number}}",
    paneSessions: "Сессии терминала в этой области",
    inputBackpressure:
      "Очередь ввода терминала заполнена. Повторите попытку чуть позже.",
    layoutLoading: "Восстановление рабочего пространства…",
    layoutNeedsReset:
      "Не удалось прочитать раскладку рабочего пространства ({{reason}}). Исходные данные сохранены, автосохранение приостановлено.",
    layoutLoadFailed:
      "Не удалось прочитать раскладку рабочего пространства: {{error}}. Этот запуск не перезапишет исходные данные.",
    retryLayoutRead: "Повторить чтение",
    resetLayout: "Сбросить раскладку рабочего пространства",
    layoutResetPending: "Сброс…",
    confirmLayoutReset:
      "Не удалось прочитать раскладку рабочего пространства. При сбросе повреждённая раскладка будет заменена пустым рабочим пространством. Продолжить?",
    layoutResetFailed: "Не удалось сбросить рабочее пространство: {{error}}",
    layoutSaveFailed:
      "Не удалось автоматически сохранить рабочее пространство: {{error}}. Терминалы остаются доступны.",
    layouts: "Раскладки",
    namedLayouts: "Именованные раскладки",
    layoutNamePlaceholder: "Название раскладки",
    saveLayout: "Сохранить текущую раскладку",
    applyLayout: "Применить",
    layoutApplied: "Раскладка применена, запущенные сессии сохранены",
    renameLayout: "Переименовать раскладку",
    overwriteLayout: "Заменить текущей раскладкой",
    deleteLayout: "Удалить раскладку",
    layoutSaved: "Раскладка сохранена",
    layoutRenamed: "Раскладка переименована",
    layoutOverwritten: "Раскладка обновлена",
    layoutDeleted: "Раскладка удалена",
    layoutActionFailed: "Не удалось выполнить действие с раскладкой: {{error}}",
    layoutChangedDuringApply:
      "Рабочее пространство изменилось во время применения раскладки. Повторите попытку.",
    layoutPresetMissing:
      "Эта именованная раскладка больше не существует. Обновите список и повторите попытку.",
    layoutsLoading: "Загрузка раскладок…",
    noNamedLayouts: "Сохранённых раскладок пока нет.",
    confirmOverwriteLayout:
      "Заменить «{{name}}» текущими областями и сессиями?",
    confirmDeleteLayout: "Удалить «{{name}}»?",
    closeLayoutManager: "Закрыть диспетчер раскладок",
    confirmLayoutAction: "Подтвердить",
    projectUnavailable:
      "Не удалось найти этот проект, поэтому терминал нельзя запустить.",
    restoredEnded:
      "Эта сессия завершена. CLI не запустится автоматически; восстановить её можно позже из истории сессий.",
    restoredMissingProject:
      "Связанный с этой сессией проект больше не существует.",
    restoredProjectMismatch:
      "Путь или идентификатор проекта изменился, поэтому подтвердить принадлежность ему этой сессии не удалось.",
    restoredMissingSession: "Запись сессии больше не существует.",
    restoredSessionMismatch:
      "Сессия больше не связана с этим проектом или CLI.",
    previousSessions: "Предыдущих элементов: {{count}}",
    nextSessions: "Следующих элементов: {{count}}",
    previousSessionsHeading: "Предыдущие элементы",
    nextSessionsHeading: "Следующие элементы",
    overflowContents: "Скрытых элементов: {{count}}",
    overflowContentsHeading: "Скрытые элементы",
    emptyPane: "Пустая область",
    empty:
      "Восстановите сессию справа или откройте файл либо запустите CLI в этой области.",
    starting: "Создание сессии терминала…",
    terminalNotReady: "Терминал ещё не готов. Повторите попытку чуть позже.",
    close: "Закрыть сессию терминала",
    closeNamed: "Закрыть {{name}}",
    sessionMenu: "Меню сессии терминала",
    closeEmptyPane: "Закрыть пустую область",
    splitRight: "Разделить справа",
    splitDown: "Разделить снизу",
    splitAndMoveRight: "Разделить справа и переместить этот терминал",
    splitAndMoveDown: "Разделить снизу и переместить этот терминал",
    moveToPane: "Переместить в область",
    dropIntoPane: "Перетащите, чтобы переместить в {{pane}}",
    openSeparateWindow: "Открыть в отдельном окне",
    returnToWorkspace: "Вернуться в рабочее пространство",
    returningToWorkspace: "Перемещение в рабочее пространство…",
    returnFailed: "Не удалось вернуться в рабочее пространство: {{error}}",
    returnTimedOut: "Главное рабочее пространство не ответило вовремя.",
    detachedDefaultTitle: "Терминал CLI",
    detachedMoveUnavailable:
      "Этот терминал нельзя переместить в отдельное окно.",
    detachedMoveNotRunning:
      "В отдельное окно можно переместить только работающий терминал.",
    detachedStartTimedOut:
      "Истекло время ожидания запуска отдельного окна терминала.",
    detachedCreateFailed: "Не удалось создать отдельное окно терминала.",
    detachedStartFailed: "Не удалось запустить отдельное окно терминала.",
    detachedStateChanged:
      "Состояние отдельного окна изменилось. Повторите попытку.",
    detachedSessionMissing:
      "Эта сессия терминала не найдена в главном рабочем пространстве.",
    workspaceRestoring:
      "Главное рабочее пространство ещё восстанавливает терминалы. Повторите попытку чуть позже.",
    detachedExitedBeforeReady:
      "PTY завершился до того, как отдельное окно приняло управление.",
    detachedClosedBeforeReady:
      "Отдельное окно закрылось до того, как приняло управление.",
    layoutDataMissing:
      "Раскладка помечена как готовая, но данные раскладки не получены.",
    namedLayoutMissing:
      "Эта именованная раскладка больше не существует. Обновите список и повторите попытку.",
    closeCurrent: "Закрыть этот терминал",
    closeOthers: "Закрыть другое содержимое области ({{count}})",
    closeAllInPane: "Закрыть всё содержимое области ({{count}})",
    splitTooSmall:
      "Для повторного разделения области требуется не менее {{size}} px по {{axis}}.",
    width: "ширина",
    height: "высота",
    confirmClose: "Завершить эту сессию терминала и её дочерние процессы?",
    confirmCloseMany:
      "Завершить эти сессии терминала ({{count}}) и их дочерние процессы?",
    closePending:
      "Запускаются сессии терминала: {{count}}. Их пока нельзя закрыть.",
    closeFailedMany:
      "Не удалось закрыть сессии терминала ({{count}}). Подробности доступны в соответствующих терминалах.",
    status: {
      running: "Работает",
      exited: "Завершён",
      terminated: "Принудительно завершён",
      failed: "Ошибка",
    },
  },
  cliStatus: {
    available: "Установлено",
    availableTitle: "Установлено и готово к запуску",
    missing: "Не найдено",
    missingTitle: "Не найдено. Откройте настройки, чтобы установить",
    unknown: "Не удалось проверить",
    unknownTitle:
      "Не удалось проверить. Обновите данные и повторите попытку; запуск и установка отключены",
  },
  time: {
    neverStarted: "Ни разу не запускалось",
    unknown: "Неизвестное время",
  },
  projects: {
    title: "Проекты",
    searchPlaceholder: "Поиск проектов по названию",
    sortRecent: "Недавно использованные",
    sortName: "Название",
    refreshCli: "Повторно обнаружить CLI",
    addDirectory: "Добавить каталог",
    chooseDirectory: "Выбрать каталог проекта",
    namePlaceholder: "Название",
    pathPlaceholder: "Полный путь или выберите «Обзор»",
    addFailed: "Не удалось добавить каталог: {{error}}",
    launchFailed: "Не удалось запустить: {{error}}",
    openPathFailed: "Не удалось открыть каталог: {{error}}",
    empty:
      "Подходящие каталоги не найдены. Выберите «Добавить каталог», чтобы создать его.",
  },
  emptyProjects: {
    title: "Выберите проект, чтобы начать",
    description:
      "Добавьте локальный проект, чтобы запускать и переключать CLI-сессии в его рабочем пространстве.",
    addProject: "Добавить проект",
  },
  projectDialog: {
    addTitle: "Добавить проект",
    editTitle: "Изменить проект",
    name: "Название проекта",
    directory: "Каталог проекта",
    chooseDirectory: "Выбрать каталог",
    chooseFailed: "Не удалось выбрать каталог проекта: {{error}}",
    note: "Примечание",
    notePlaceholder: "Необязательное примечание о проекте",
    loading: "Загрузка сведений о проекте…",
    saving: "Сохранение…",
    saveFailed: "Не удалось сохранить проект: {{error}}",
  },
  projectDetail: {
    noDirectory: "Каталог не выбран.",
    context: "Контекст проекта",
    cliLaunchers: "Запустить CLI",
    showContextPanel: "Показать контекст проекта",
    hideContextPanel: "Скрыть контекст проекта",
    openDirectory: "Открыть каталог",
    openPathFailed: "Не удалось открыть каталог: {{error}}",
    launchTool: "Запустить {{tool}} во встроенном терминале",
    sessions: "История сессий",
    searchSessions: "Поиск сессий",
    searchPlaceholder: "Поиск по названиям сессий, описаниям и псевдонимам",
    clearSearch: "Очистить поиск",
    searchIncomplete:
      "Не все источники сессий удалось полностью просмотреть: {{tools}}",
    searchFailed: "Не удалось выполнить поиск сессий: {{error}}",
    noSearchResults: "Подходящие сессии не найдены.",
    resumeEmbedded: "Продолжить",
    refreshSessions: "Обновить сессии",
    sessionsFailed: "Не удалось прочитать сессии: {{error}}",
    reading: "Загрузка…",
    aliasRequired: "Псевдоним сессии не может быть пустым",
    sessionAlias: "Псевдоним сессии",
    originalTitle: "Исходное название: {{title}}",
    customTitle: "Пользовательское название",
    saveAlias: "Сохранить псевдоним сессии",
    cancelRename: "Отменить переименование",
    renameSession: "Переименовать сессию",
    restoreOriginal: "Восстановить исходное название",
    restore: "Продолжить",
    loadMoreFailed: "Не удалось загрузить следующие записи: {{error}}",
    noSessions: "История сессий пуста.",
  },
  settings: {
    title: "Настройки",
    refresh: "Обнаружить снова",
    cliStatus: "Состояние CLI",
    detectFailed: "Не удалось выполнить обнаружение: {{error}}",
    updateAvailable: "Доступно обновление",
    taskActiveTitle: "Задача установки или обновления уже выполняется",
    preparing: "Подготовка…",
    install: "Установить",
    update: "Обновить",
    grokInstallEffectsHeading:
      "Официальный установщик выполнит следующие действия:",
    grokInstallEffectPath:
      "Установит программу в .grok\\bin профиля текущего пользователя или в GROK_BIN_DIR, если он задан.",
    grokInstallEffectChannel:
      "Launchpad закрепляет стабильный канал, поэтому унаследованные переменные среды не смогут выбрать предварительный или корпоративный канал.",
    grokInstallEffectFiles:
      "Загрузит и установит grok.exe и agent.exe, заменив существующие файлы; создаст или обновит маркер установщика CLI в .grok\\config.toml профиля текущего пользователя и создаст дополнения PowerShell.",
    grokInstallEffectPathEnv:
      "Добавит каталог установки в PATH текущего пользователя, если его там ещё нет.",
    grokInstallEffectNetwork:
      "Получит сведения о версии и исполняемые файлы с x.ai, используя Google Cloud Storage в качестве резервного источника. Если в среде задан GROK_DEPLOYMENT_KEY, также загрузит настройки развёртывания и запишет управляемые файлы конфигурации.",
    grokPosixInstallEffectsHeading: "The official macOS/Linux installer will:",
    grokPosixInstallEffectPath:
      "Place files in ~/.grok/bin by default; GROK_BIN_DIR can change that location. If ~/.local/bin or /usr/local/bin is already on PATH and writable, the script may also create grok and agent symlinks there.",
    grokPosixInstallEffectFiles:
      "Download the platform binary to ~/.grok/downloads and create or replace grok and agent symlinks in ~/.grok/bin. It also writes ~/.grok/config.toml and Bash, Zsh, and Fish completion files.",
    grokPosixInstallEffectShell:
      "When it recognizes the login shell, update ~/.bashrc, ~/.zshrc, or the Fish config so future sessions add ~/.grok/bin to PATH; it backs up an existing target config before its first edit. On macOS Bash, it may also append a line to an existing ~/.bash_profile to source ~/.bashrc.",
    grokPosixInstallEffectNetwork:
      "Fetch version data and binaries from x.ai, falling back to Google Cloud Storage if needed. Deployment settings are fetched and written only when GROK_DEPLOYMENT_KEY is present. Launchpad pins the stable channel.",
    grokUpdateSourceUnknown:
      "Сначала обновите сведения о версии, чтобы проверить источник установки Grok Build.",
    installing: "Установка…",
    updating: "Обновление…",
    refreshingVersion: "Обновление версии…",
    refreshingVersionTitle: "Чтение обновлённой версии CLI",
    refreshingVersionDescription:
      "Задача завершена. Проверка состояния обновлённой версии.",
    confirmInstall: "Подтвердить установку",
    confirmUpdate: "Подтвердить обновление",
    creatingTask: "Создание задачи…",
    confirmRun: "Запустить",
    source: "Источник: {{source}}",
    commandNotice:
      "Эта команда будет выполнена на вашем компьютере. После подтверждения отслеживайте её журнал в разделе «Задачи».",
    executeFailed: "Не удалось выполнить команду: {{error}}",
    path: "Путь: {{path}}",
    current: "Текущая: ",
    latest: "Последняя: ",
    unavailableWithError: "Недоступно ({{error}})",
    unknownRefresh:
      "Неизвестно; выполните обнаружение повторно в правом верхнем углу",
    hermesRefreshPrompt: "Обновите вручную, чтобы проверить ветку main",
    hermesUpToDate: "Обновлено до состояния main",
    hermesUpdateBehind: "Отставание от main: {{count}} коммитов",
    hermesUpdateBehindUnknown:
      "Есть обновления в main (число коммитов недоступно)",
    hermesUpdateStatus: "Состояние обновления: ",
    hermesInstallEffectsHeading:
      "Официальный установщик выполнит следующие действия:",
    hermesInstallEffectRuntime:
      "Установит Hermes CLI, управляемые среды Python/Node и зависимости для текущего пользователя.",
    hermesInstallEffectData:
      "Подготовит исходный код, конфигурацию и данные пользователя в %LOCALAPPDATA%\\hermes; обработкой существующих данных займётся официальный установщик.",
    hermesInstallEffectPath:
      "Добавит %LOCALAPPDATA%\\hermes\\bin в PATH текущего пользователя, если он ещё не настроен.",
    hermesInstallEffectNetwork:
      "Загрузит скрипт с официального адреса установщика Hermes, а также исходный код, среды выполнения и зависимости.",
    hermesPosixInstallEffectsHeading:
      "The official macOS/Linux installer will:",
    hermesPosixInstallEffectLayout:
      "Create or update source under ~/.hermes/hermes-agent, publish the hermes command under ~/.local/bin, and prepare configuration and user data under ~/.hermes. A new .env file is restricted to the current user; existing config files are not replaced by initial templates.",
    hermesPosixInstallEffectRuntime:
      "Download the checksum-verified uv tool, then prepare managed Python, dependencies, and tool caches in the Hermes data area. Installer logs go to ~/.hermes/logs/install.log.",
    hermesPosixInstallEffectShell:
      "Update the startup file for the detected shell to add ~/.local/bin to PATH. Reload the shell configuration or open a new terminal before running hermes from a terminal.",
    hermesPosixInstallEffectOptions:
      "Launchpad passes options to skip the browser and computer-use components, so these optional tools are not installed. Hermes remembers this choice; they can be installed later with hermes pm install.",
    hermesPosixInstallEffectSetup:
      "This non-interactive run skips the first-run setup wizard. Run hermes setup after installation to configure a model and tools.",
    hermesPosixInstallEffectNetwork:
      "Fetch the installer from the official Hermes address, clone the main source from NousResearch GitHub, and download a pinned SHA-256-verified uv build and project dependencies. If the uv download has a network failure, the official script can use its mirror.",
    checking: "Проверка…",
    cachedSuffix: " (из кэша)",
    refreshFailedSuffix: "; не удалось обновить: {{error}}",
    unavailable: "Недоступно",
    managementComingSoon: "Установка и обновление будут добавлены позже.",
    prepareFailed: "Не удалось подготовить действие: {{error}}",
    taskRunning:
      "Для этого инструмента выполняется задача. Откройте раздел «Задачи» на боковой панели, чтобы следить за ней.",
    launchMethod: "Способ запуска",
    launchHintMac:
      "В автоматическом режиме всегда используется Terminal.app. Сторонние терминалы применяются только при явном выборе.",
    launchHintWindows:
      "В первую очередь используется профиль Windows Terminal, а при его недоступности — отдельная оболочка.",
    launchHintLinux:
      "В автоматическом режиме сначала используется терминал рабочего стола по умолчанию. Также можно вручную выбрать обнаруженный терминал.",
    launchHintOther:
      "Обнаружить доступные способы запуска терминала для текущей платформы.",
    refreshTerminal: "Повторно обнаружить среду терминала",
    detectingTerminal: "Обнаружение среды терминала…",
    launchLoadFailed: "Не удалось загрузить способы запуска: {{error}}",
    autoSelect: "Автоматически",
    autoDescriptionMac:
      "Всегда использовать Terminal.app. Установка стороннего терминала не изменит поведение по умолчанию.",
    autoDescriptionWindows:
      "Сначала использовать профиль Windows Terminal по умолчанию, затем PowerShell 7, Windows PowerShell и CMD.",
    autoDescriptionLinux:
      "Сначала передать запуск терминалу рабочего стола по умолчанию через xdg-terminal-exec, затем перебирать обнаруженные терминалы по порядку.",
    recommended: "Рекомендуется",
    unknownVersion: "Неизвестная версия",
    noProfiles:
      "Выбираемые профили не найдены. В автоматическом режиме будет предпринята попытка использовать профиль по умолчанию.",
    defaultProfile: "Профиль по умолчанию",
    standaloneConsole: "Отдельные консоли",
    standaloneDescription: "Не использовать профиль Windows Terminal",
    fallbackPriority: "Приоритет резервного варианта {{priority}}",
    standaloneWindow: "Отдельное окно",
    macTerminals: "Терминалы macOS",
    linuxTerminals: "Терминалы Linux",
    detectedCount_one: "Обнаружено: {{count}}",
    detectedCount_other: "Обнаружено: {{count}}",
    noTerminals:
      "Доступные терминалы не найдены. Автоматический запуск сейчас недоступен.",
    systemDefault: "Системное значение по умолчанию",
    native: "Системный",
    unavailableSavedTarget:
      "Сохранённая цель запуска {{target}} недоступна на этой платформе. При запуске будет использоваться рекомендуемый терминал. Выберите доступный терминал, чтобы изменить эту настройку.",
    saveLaunchFailed: "Не удалось сохранить способ запуска: {{error}}",
    closeBehavior: "Поведение при закрытии окна",
    closeDescriptionMac:
      "По умолчанию приложение продолжает работать в фоне после закрытия. Чтобы снова показать его, используйте значок Dock или пункт меню.",
    closeDescriptionOther:
      "По умолчанию приложение остаётся в системном трее после закрытия. Дважды щёлкните значок в трее, чтобы снова показать его.",
    closeMinimize: "Оставить работающим в фоне",
    closeQuit: "Выйти из приложения",
    saveFailed: "Не удалось сохранить: {{error}}",
    configBackup: "Резервная копия конфигурации",
    configBackupDescription:
      "Экспортируйте или импортируйте каталоги проектов и заметки. При импорте записи объединяются по пути без дублирования каталогов.",
    exportFile: "Экспортировать в файл",
    importFile: "Импортировать из файла",
    exported: "Экспорт завершён.",
    exportFailed: "Не удалось экспортировать: {{error}}",
    importSuccess: "Импорт выполнен.",
    importFailed: "Не удалось импортировать: {{error}}",
    diagnostics: "Диагностика",
    exportDiagnostics: "Экспортировать отчёт диагностики",
    recentLaunch: "Недавние запуски",
    launchHistoryRetention: "Хранить историю",
    launchHistoryRetentionCount: "Последние запусков: {{count}}",
    launchHistoryProject: "Проект: ",
    launchHistoryPath: "Путь: ",
    launchHistoryTime: "Время: ",
    launchHistorySessionId: "ID сессии: ",
    clearHistory: "Очистить историю",
    resumeSession: "Возобновить сессию",
    newSession: "Новая сессия",
    success: "Успешно",
    failed: "Ошибка",
    cache: "Кэш",
    entries: "Записей: {{count}}",
    size: "Размер: {{size}}",
    newestWrite: "Последняя запись: {{time}}",
    clearCache: "Очистить кэш",
    recovery: "Восстановление данных",
    recoveryDescription:
      "Перед импортом и восстановлением автоматически создаются контрольные точки. Ручные точки сохраняют все текущие данные приложения.",
    createRecovery: "Создать точку восстановления",
    readRecoveryFailed: "Не удалось прочитать точки восстановления: {{error}}",
    restore: "Восстановить",
    confirmRestore: "Восстановить данные?",
    restoreDescription:
      "Восстановить данные до состояния на {{time}}. Сначала текущее состояние будет автоматически сохранено.",
    confirmRestoreAction: "Подтвердить восстановление",
    restoreFailed: "Не удалось восстановить данные: {{error}}",
    restoreBlockedPtys: "Активные сеансы терминала: {{count}}",
    restoreBlockedDirtyFiles:
      "Документы с несохранёнными изменениями: {{count}}",
    restoreBlockedDetachedWindows: "Отсоединённые окна содержимого: {{count}}",
    backupReason: {
      manual: "Ручная точка восстановления",
      pre_import: "Автоматическая копия перед импортом",
      pre_restore: "Защитная копия перед восстановлением",
      pre_migration: "Автоматическая копия перед обновлением",
    },
    preservation: {
      exact: "Сохранено полностью",
      command_continuation: "Продолжение команды",
      appearance_only: "Только внешний вид",
    },
    shell: { custom: "Пользовательская оболочка" },
    terminalDescription: {
      command_document:
        "Открыть через LaunchServices одноразовый файл .command, который удаляет себя после выполнения",
      apple_script:
        "Создать нативное окно Ghostty и ввести команду через AppleScript",
      direct_arguments:
        "Передать структурированные аргументы официальной CLI в пакете приложения",
      kittySuffix: ", оставив окно открытым после завершения команды",
      xdg_terminal_exec:
        "Передать запуск терминалу рабочего стола по умолчанию (xdg-terminal-exec)",
      shell_wrapped: "Запустить команду в новом окне с помощью параметра -e",
    },
  },
  about: {
    title: "О приложении",
    version: "Версия {{version}}",
    description:
      "Рабочее пространство для настольного компьютера, ориентированное на проекты: поддержка пяти AI CLI, встроенный многопанельный терминал, история и восстановление сессий, а также повторно используемые раскладки.",
    supportedCli: "Поддерживаемые CLI",
    repository: "Репозиторий проекта",
    repositoryDescription: "Исходный код CLI Launchpad и новости проекта.",
    openRepository: "Открыть на GitHub",
    openRepositoryError:
      "Не удалось открыть репозиторий GitHub в браузере по умолчанию.",
    licenses: "Лицензии с открытым исходным кодом",
    licenseIntro:
      "CLI Launchpad и встроенные фирменные значки распространяются по лицензии MIT. На встроенные шрифты по-прежнему распространяются соответствующие условия SIL Open Font License 1.1.",
  },
  executions: {
    title: "Задачи",
    description:
      "Просмотр текущего вывода и истории задач установки и обновления.",
    operationInstall: "установка",
    operationUpdate: "обновление",
    taskToastTitle: "{{tool}} {{operation}}",
    taskSucceededToast: "{{title}} выполнено успешно",
    taskFailedToast: "{{title}} завершилось с ошибкой",
    taskStoppedToast: "{{title}} остановлено",
    refresh: "Обновить задачи",
    clearHistory: "Очистить историю",
    clearAllTitle: "Удалить все завершённые задачи?",
    clearAllDescription:
      "Задачи ({{count}}) и их журналы будут удалены без возможности восстановления.",
    clearing: "Очистка…",
    confirmClear: "Очистить задачи",
    readFailed: "Не удалось прочитать задачи: {{error}}",
    operationFailed: "Операция завершилась с ошибкой: {{error}}",
    listLabel: "Список задач",
    readingTasks: "Загрузка задач…",
    emptyTitle: "Задач пока нет",
    emptyDescription:
      "Установите или обновите CLI в настройках, чтобы задача появилась здесь.",
    install: "Установить",
    update: "Обновить",
    selectTask: "Выберите задачу, чтобы просмотреть её журнал.",
    source: "Источник: {{source}}",
    cancelling: "Остановка",
    cancelTask: "Остановить задачу",
    clearRecord: "Удалить запись",
    cancelTitle: "Остановить эту задачу?",
    cancelDescription:
      "Будет завершено всё дерево процессов. Прерывание обновления может потребовать повторной установки CLI.",
    requesting: "Отправка запроса…",
    confirmCancel: "Подтвердить остановку",
    deleteTitle: "Удалить эту запись задачи?",
    deleteDescription:
      "Связанные журналы также будут удалены без возможности восстановления.",
    deleting: "Удаление…",
    confirmDelete: "Подтвердить удаление",
    startedAt: "Запущено: {{time}}",
    exitCode: "Код выхода {{code}}",
    followOutput: "Следить за последним выводом",
    readingLogs: "Загрузка журналов…",
    noOutput: "(Вывода пока нет)",
    truncated: "Достигнут предел журнала 1 MiB. Последующий вывод не сохранён.",
    status: {
      preparing: "Подготовка",
      running: "Выполняется",
      cancelling: "Остановка",
      succeeded: "Успешно завершено",
      failed: "Ошибка",
      cancelled: "Отменено",
      timed_out: "Время ожидания истекло",
      interrupted: "Неожиданно прервано",
    },
    stream: {
      stdout: "Вывод",
      stderr: "Ошибка",
      system: "Система",
    },
  },
  workspaceFiles: {
    rightPanelTabs: "Вкладки правой панели",
    files: "Файлы",
    git: "Git",
    gitLater: "Управление Git появится в одном из следующих этапов.",
    projectRoot: "Корень проекта",
    refresh: "Обновить",
    showHidden: "Показывать скрытые файлы",
    emptyDirectory: "Папка пуста",
    symlinkDisabled: "Символические ссылки пока нельзя открывать",
    ignored: "Игнорируется",
    closeFile: "Закрыть файл",
    closeFileNamed: "Закрыть {{name}}",
    fileMenu: "Меню окна файла",
    closeOthers: "Закрыть другое содержимое области ({{count}})",
    closeAllInPane: "Закрыть всё содержимое области ({{count}})",
    splitAndMoveRight: "Разделить справа и переместить этот файл",
    splitAndMoveDown: "Разделить снизу и переместить этот файл",
    discardChanges:
      "В файле есть несохранённые изменения. Закрыть и отменить их?",
    save: "Сохранить",
    reload: "Перезагрузить",
    saveConflict:
      "Файл на диске изменился. Ваши правки сохранены в редакторе. Перезагрузите файл перед повторным сохранением.",
    directoryLimitReached: "Слишком много элементов. Показаны первые 5 000.",
    directoryEntriesSkipped: "Не удалось показать элементов: {{count}}.",
    projectIdentityChanged:
      "Идентификатор каталога проекта изменился. Документ устарел; скопируйте его содержимое перед закрытием.",
    loadingFile: "Загрузка файла…",
    editorUnavailable: "Текстовый редактор сейчас недоступен.",
    fileCannotOpen: "Этот файл нельзя открыть здесь",
    imagePreview: "Предпросмотр изображения",
    unsupported: {
      binary: "Текстовый редактор не поддерживает двоичные файлы.",
      tooLarge: "Размер файла превышает ограничение предпросмотра.",
      invalidImage: "Данные изображения не соответствуют расширению файла.",
      unsupportedImage: "Этот формат изображения не поддерживается.",
    },
  },
} satisfies LocaleShape<typeof en>;
