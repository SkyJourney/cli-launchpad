import type { en } from "./en";

type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const de = {
  common: {
    back: "Zurück",
    browse: "Durchsuchen",
    cancel: "Abbrechen",
    confirm: "Bestätigen",
    save: "Speichern",
    copy: "Kopieren",
    more: "Mehr",
    loading: "Wird geladen…",
    none: "(Keine)",
  },
  sidebar: {
    projects: "Projekte",
    collapse: "Seitenleiste einklappen",
    expand: "Seitenleiste ausklappen",
    addProject: "Projekt hinzufügen",
    searchProjects: "Projekte nach Namen suchen",
    projectActions: "Aktionen für {{name}}",
    renameProject: "Projekt umbenennen",
    pinProject: "Projekt anheften",
    unpinProject: "Projekt lösen",
    openProjectFolder: "Projektordner öffnen",
    removeProject: "Projekt entfernen",
    confirmRemoveProject:
      "Projekt „{{name}}“ entfernen? Dateien auf dem Datenträger werden nicht gelöscht.",
    pinProjectFailed: "Projekt konnte nicht angeheftet werden: {{error}}",
    reorderProjectsFailed:
      "Projekte konnten nicht neu sortiert werden: {{error}}",
    openProjectFolderFailed:
      "Projektordner konnte nicht geöffnet werden: {{error}}",
    removeProjectFailed: "Projekt konnte nicht entfernt werden: {{error}}",
    noProjects: "Noch keine Projekte. Füge ein Projekt hinzu, um zu beginnen.",
    noMatchingProjects: "Keine passenden Projekte.",
    executions: "Aufgaben",
    settings: "Einstellungen",
    about: "Über",
    activeTasks_one: "{{count}} aktive Aufgabe",
    activeTasks_other: "{{count}} aktive Aufgaben",
    managedCliSessions_one: "{{tool}}, {{count}} verwaltete Sitzung",
    managedCliSessions_other: "{{tool}}, {{count}} verwaltete Sitzungen",
  },
  theme: {
    current: "Design: {{mode}}",
    select: "Design auswählen",
    light: "Hell",
    dark: "Dunkel",
    system: "System",
  },
  language: {
    current: "Sprache: {{language}}",
    select: "Sprache auswählen",
    zh: "简体中文",
    en: "English",
  },
  appExit: {
    title: "CLI Launchpad beenden?",
    description:
      "{{count}} eingebettete Terminalsitzungen laufen noch. Beim Beenden werden diese Sitzungen und ihre Kindprozesse beendet.",
    confirm: "Sitzungen beenden und schließen",
    unsavedDescription:
      "{{count}} Datei(en) enthalten ungespeicherte Änderungen:",
    confirmDiscard: "Änderungen verwerfen und schließen",
    terminating: "Wird beendet…",
  },
  windowChrome: {
    titlebar: "Titelleiste des Anwendungsfensters",
    minimize: "Minimieren",
    maximize: "Maximieren",
    restore: "Wiederherstellen",
    close: "Fenster schließen",
  },
  pty: {
    panelLabel: "Eingebettetes Terminal",
    paneLabel: "Terminalbereich",
    paneNumber: "Bereich {{number}}",
    paneSessions: "Terminalsitzungen in diesem Bereich",
    inputBackpressure:
      "Die Terminal-Eingabewarteschlange ist voll. Bitte gleich erneut versuchen.",
    layoutLoading: "Arbeitsbereich wird wiederhergestellt…",
    layoutNeedsReset:
      "Das Arbeitsbereichlayout konnte nicht gelesen werden ({{reason}}). Die Originaldaten bleiben erhalten und das automatische Speichern wurde pausiert.",
    layoutLoadFailed:
      "Arbeitsbereichlayout konnte nicht gelesen werden: {{error}}. Dieser Lauf überschreibt die Originaldaten nicht.",
    retryLayoutRead: "Erneut lesen",
    resetLayout: "Arbeitsbereichlayout zurücksetzen",
    layoutResetPending: "Wird zurückgesetzt…",
    confirmLayoutReset:
      "Das Arbeitsbereichlayout kann nicht gelesen werden. Beim Zurücksetzen wird das beschädigte Layout durch einen leeren Arbeitsbereich ersetzt. Fortfahren?",
    layoutResetFailed:
      "Arbeitsbereich konnte nicht zurückgesetzt werden: {{error}}",
    layoutSaveFailed:
      "Arbeitsbereich konnte nicht automatisch gespeichert werden: {{error}}. Terminals bleiben verfügbar.",
    layouts: "Layouts",
    namedLayouts: "Benannte Layouts",
    layoutNamePlaceholder: "Layoutname",
    saveLayout: "Aktuelles Layout speichern",
    applyLayout: "Anwenden",
    layoutApplied: "Layout angewendet; laufende Sitzungen blieben erhalten",
    renameLayout: "Layout umbenennen",
    overwriteLayout: "Mit aktuellem Layout überschreiben",
    deleteLayout: "Layout löschen",
    layoutSaved: "Layout gespeichert",
    layoutRenamed: "Layout umbenannt",
    layoutOverwritten: "Layout aktualisiert",
    layoutDeleted: "Layout gelöscht",
    layoutActionFailed: "Layoutaktion fehlgeschlagen: {{error}}",
    layoutChangedDuringApply:
      "Der Arbeitsbereich wurde während der Anwendung des Layouts geändert. Bitte versuche es erneut.",
    layoutPresetMissing:
      "Dieses benannte Layout ist nicht mehr vorhanden. Aktualisiere die Liste und versuche es erneut.",
    layoutsLoading: "Layouts werden geladen…",
    noNamedLayouts: "Noch keine Layouts gespeichert.",
    confirmOverwriteLayout:
      "„{{name}}“ mit den aktuellen Bereichen und Sitzungen überschreiben?",
    confirmDeleteLayout: "„{{name}}“ löschen?",
    closeLayoutManager: "Layoutverwaltung schließen",
    confirmLayoutAction: "Bestätigen",
    projectUnavailable:
      "Dieses Projekt wurde nicht gefunden. Das Terminal kann daher nicht gestartet werden.",
    restoredEnded:
      "Diese Sitzung wurde beendet. Die CLI wird nicht automatisch gestartet; du kannst sie später über den Sitzungsverlauf wiederherstellen.",
    restoredMissingProject:
      "Das mit dieser Sitzung verknüpfte Projekt ist nicht mehr vorhanden.",
    restoredProjectMismatch:
      "Projektpfad oder Identität wurden geändert. Die Zugehörigkeit dieser Sitzung zum Projekt kann nicht bestätigt werden.",
    restoredMissingSession: "Der Sitzungseintrag ist nicht mehr vorhanden.",
    restoredSessionMismatch:
      "Die Sitzung ist nicht mehr mit diesem Projekt oder dieser CLI verknüpft.",
    previousSessions: "{{count}} frühere Einträge",
    nextSessions: "{{count}} spätere Einträge",
    previousSessionsHeading: "Frühere Inhalte",
    nextSessionsHeading: "Spätere Inhalte",
    overflowContents: "{{count}} ausgeblendete Inhalte",
    overflowContentsHeading: "Ausgeblendete Inhalte",
    emptyPane: "Leerer Bereich",
    empty:
      "Stelle rechts eine Sitzung wieder her oder öffne hier eine Datei bzw. starte eine CLI.",
    starting: "Terminalsitzung wird erstellt…",
    terminalNotReady:
      "Das Terminal ist noch nicht bereit. Versuche es gleich erneut.",
    close: "Terminalsitzung schließen",
    closeNamed: "{{name}} schließen",
    sessionMenu: "Menü der Terminalsitzung",
    closeEmptyPane: "Leeren Bereich schließen",
    splitRight: "Rechts teilen",
    splitDown: "Nach unten teilen",
    splitAndMoveRight: "Rechts teilen und dieses Terminal verschieben",
    splitAndMoveDown: "Nach unten teilen und dieses Terminal verschieben",
    moveToPane: "In Bereich verschieben",
    dropIntoPane: "Zum Verschieben in {{pane}} ablegen",
    openSeparateWindow: "In separatem Fenster öffnen",
    returnToWorkspace: "Zum Arbeitsbereich zurückkehren",
    returningToWorkspace: "Wird in den Arbeitsbereich verschoben…",
    returnFailed: "Rückkehr zum Arbeitsbereich fehlgeschlagen: {{error}}",
    returnTimedOut:
      "Der Hauptarbeitsbereich hat nicht rechtzeitig geantwortet.",
    detachedDefaultTitle: "CLI-Terminal",
    detachedMoveUnavailable:
      "Dieses Terminal kann nicht in ein separates Fenster verschoben werden.",
    detachedMoveNotRunning:
      "Nur ein laufendes Terminal kann in ein separates Fenster verschoben werden.",
    detachedStartTimedOut:
      "Zeitüberschreitung beim Starten des separaten Terminalfensters.",
    detachedCreateFailed:
      "Separates Terminalfenster konnte nicht erstellt werden.",
    detachedStartFailed:
      "Separates Terminalfenster konnte nicht gestartet werden.",
    detachedStateChanged:
      "Der Status des separaten Terminalfensters hat sich geändert. Bitte versuche es erneut.",
    detachedSessionMissing:
      "Diese Terminalsitzung wurde im Hauptarbeitsbereich nicht gefunden.",
    workspaceRestoring:
      "Der Hauptarbeitsbereich stellt noch Terminals wieder her. Bitte versuche es gleich erneut.",
    detachedExitedBeforeReady:
      "Der PTY wurde beendet, bevor das separate Fenster die Steuerung übernahm.",
    detachedClosedBeforeReady:
      "Das separate Fenster wurde geschlossen, bevor es die Steuerung übernahm.",
    layoutDataMissing:
      "Das Layout wurde als bereit markiert, aber es wurden keine Layoutdaten zurückgegeben.",
    namedLayoutMissing:
      "Dieses benannte Layout ist nicht mehr vorhanden. Aktualisiere die Liste und versuche es erneut.",
    closeCurrent: "Dieses Terminal schließen",
    closeOthers: "Andere Inhalte in diesem Bereich schließen ({{count}})",
    closeAllInPane: "Alle Inhalte in diesem Bereich schließen ({{count}})",
    splitTooSmall:
      "Der Bereich benötigt mindestens {{size}} px {{axis}}, um erneut geteilt zu werden.",
    width: "Breite",
    height: "Höhe",
    confirmClose: "Diese Terminalsitzung und ihre Kindprozesse beenden?",
    confirmCloseMany:
      "Diese {{count}} Terminalsitzungen und ihre Kindprozesse beenden?",
    closePending:
      "{{count}} Terminalsitzungen werden noch gestartet und können derzeit nicht geschlossen werden.",
    closeFailedMany:
      "{{count}} Terminalsitzungen konnten nicht geschlossen werden. Prüfe die betroffenen Terminals auf Details.",
    status: {
      running: "Läuft",
      exited: "Beendet",
      terminated: "Abgebrochen",
      failed: "Fehlgeschlagen",
    },
  },
  cliStatus: {
    available: "Installiert",
    availableTitle: "Installiert und startbereit",
    missing: "Nicht gefunden",
    missingTitle: "Nicht gefunden. Öffne die Einstellungen zur Installation.",
    unknown: "Prüfung fehlgeschlagen",
    unknownTitle:
      "Prüfung fehlgeschlagen. Aktualisiere zum erneuten Versuch; Start und Installation sind deaktiviert.",
  },
  time: {
    neverStarted: "Noch nie gestartet",
    unknown: "Unbekannte Zeit",
  },
  projects: {
    title: "Projekte",
    searchPlaceholder: "Projekte nach Namen suchen",
    sortRecent: "Zuletzt verwendet",
    sortName: "Name",
    refreshCli: "CLIs erneut erkennen",
    addDirectory: "Verzeichnis hinzufügen",
    chooseDirectory: "Projektverzeichnis auswählen",
    namePlaceholder: "Name",
    pathPlaceholder: "Vollständiger Pfad oder Durchsuchen auswählen",
    addFailed: "Verzeichnis konnte nicht hinzugefügt werden: {{error}}",
    launchFailed: "Start fehlgeschlagen: {{error}}",
    openPathFailed: "Verzeichnis konnte nicht geöffnet werden: {{error}}",
    empty:
      "Keine passenden Verzeichnisse. Wähle „Verzeichnis hinzufügen“, um eines anzulegen.",
  },
  emptyProjects: {
    title: "Wähle ein Projekt, um zu beginnen",
    description:
      "Füge ein lokales Projekt hinzu, um CLI-Sitzungen in seinem Arbeitsbereich zu starten und zu wechseln.",
    addProject: "Projekt hinzufügen",
  },
  projectDialog: {
    addTitle: "Projekt hinzufügen",
    editTitle: "Projekt bearbeiten",
    name: "Projektname",
    directory: "Projektverzeichnis",
    chooseDirectory: "Verzeichnis auswählen",
    chooseFailed:
      "Projektverzeichnis konnte nicht ausgewählt werden: {{error}}",
    note: "Notiz",
    notePlaceholder: "Optionale Notiz zu diesem Projekt",
    loading: "Projektdetails werden geladen…",
    saving: "Wird gespeichert…",
    saveFailed: "Projekt konnte nicht gespeichert werden: {{error}}",
  },
  projectDetail: {
    noDirectory: "Kein Verzeichnis ausgewählt.",
    context: "Projektkontext",
    cliLaunchers: "CLI starten",
    showContextPanel: "Projektkontext anzeigen",
    hideContextPanel: "Projektkontext ausblenden",
    openDirectory: "Verzeichnis öffnen",
    openPathFailed: "Verzeichnis konnte nicht geöffnet werden: {{error}}",
    launchTool: "{{tool}} im eingebetteten Terminal starten",
    sessions: "Sitzungsverlauf",
    searchSessions: "Sitzungen suchen",
    searchPlaceholder:
      "Sitzungstitel, Zusammenfassungen oder Aliasse durchsuchen",
    clearSearch: "Suche löschen",
    searchIncomplete:
      "Einige Sitzungsquellen konnten nicht vollständig durchsucht werden: {{tools}}",
    searchFailed: "Sitzungssuche fehlgeschlagen: {{error}}",
    noSearchResults: "Keine passenden Sitzungen.",
    resumeEmbedded: "Fortsetzen",
    refreshSessions: "Sitzungen aktualisieren",
    sessionsFailed: "Sitzungen konnten nicht gelesen werden: {{error}}",
    reading: "Wird geladen…",
    aliasRequired: "Der Sitzungsalias darf nicht leer sein",
    sessionAlias: "Sitzungsalias",
    originalTitle: "Originaltitel: {{title}}",
    customTitle: "Eigener Titel",
    saveAlias: "Sitzungsalias speichern",
    cancelRename: "Umbenennen abbrechen",
    renameSession: "Sitzung umbenennen",
    restoreOriginal: "Originaltitel wiederherstellen",
    restore: "Fortsetzen",
    loadMoreFailed: "Weitere Einträge konnten nicht geladen werden: {{error}}",
    noSessions: "Kein Sitzungsverlauf.",
  },
  settings: {
    title: "Einstellungen",
    refresh: "Erneut erkennen",
    cliStatus: "CLI-Status",
    detectFailed: "Erkennung fehlgeschlagen: {{error}}",
    updateAvailable: "Update verfügbar",
    taskActiveTitle: "Eine Installations- oder Updateaufgabe läuft bereits",
    preparing: "Wird vorbereitet…",
    install: "Installieren",
    update: "Aktualisieren",
    grokInstallEffectsHeading: "Das offizielle Installationsprogramm wird:",
    grokInstallEffectPath:
      "Im Profil des aktuellen Benutzers unter .grok\\bin installieren oder unter GROK_BIN_DIR, falls festgelegt.",
    grokInstallEffectChannel:
      "Launchpad legt den stabilen Kanal fest, damit geerbte Umgebungsvariablen keinen Vorab- oder Enterprise-Kanal auswählen.",
    grokInstallEffectFiles:
      "grok.exe und agent.exe herunterladen und installieren, vorhandene Dateien ersetzen, den Installationsmarker der CLI in .grok\\config.toml im Profil des aktuellen Benutzers erstellen oder aktualisieren und PowerShell-Vervollständigungen erzeugen.",
    grokInstallEffectPathEnv:
      "Das Installationsverzeichnis zum PATH des aktuellen Benutzers hinzufügen, falls es noch nicht vorhanden ist.",
    grokInstallEffectNetwork:
      "Versionsinformationen und Binärdateien von x.ai abrufen, mit Google Cloud Storage als Ausweichquelle. Wenn GROK_DEPLOYMENT_KEY in der Umgebung vorhanden ist, auch Deployment-Einstellungen abrufen und verwaltete Konfigurationsdateien schreiben.",
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
      "Aktualisiere zuerst die Versionsinformationen, um die Installationsquelle von Grok Build zu überprüfen.",
    installing: "Wird installiert…",
    updating: "Wird aktualisiert…",
    refreshingVersion: "Version wird aktualisiert…",
    refreshingVersionTitle: "Aktualisierte CLI-Version wird gelesen",
    refreshingVersionDescription:
      "Die Aufgabe ist abgeschlossen. Der aktualisierte Versionsstatus wird bestätigt.",
    confirmInstall: "Installation bestätigen",
    confirmUpdate: "Update bestätigen",
    creatingTask: "Aufgabe wird erstellt…",
    confirmRun: "Ausführen",
    source: "Quelle: {{source}}",
    commandNotice:
      "Dieser Befehl wird auf deinem Computer ausgeführt. Nach der Bestätigung findest du die Live-Protokolle unter „Aufgaben“.",
    executeFailed: "Ausführung fehlgeschlagen: {{error}}",
    path: "Pfad: {{path}}",
    current: "Aktuell: ",
    latest: "Neueste: ",
    unavailableWithError: "Nicht verfügbar ({{error}})",
    unknownRefresh: "Unbekannt; oben rechts erneut erkennen",
    hermesRefreshPrompt: "Manuell aktualisieren, um den main-Branch zu prüfen",
    hermesUpToDate: "Auf dem neuesten Stand von main",
    hermesUpdateBehind: "{{count}} Commits hinter main",
    hermesUpdateBehindUnknown:
      "Updates auf main (Anzahl der Commits nicht verfügbar)",
    hermesUpdateStatus: "Update-Status: ",
    hermesInstallEffectsHeading: "Das offizielle Installationsprogramm wird:",
    hermesInstallEffectRuntime:
      "Hermes CLI, die verwalteten Python-/Node-Laufzeiten und Abhängigkeiten für den aktuellen Benutzer installieren.",
    hermesInstallEffectData:
      "Quellcode, Konfiguration und Benutzerdaten unter %LOCALAPPDATA%\\hermes vorbereiten; vorhandene Daten behandelt das offizielle Installationsprogramm.",
    hermesInstallEffectPath:
      "%LOCALAPPDATA%\\hermes\\bin zum PATH des aktuellen Benutzers hinzufügen, falls noch nicht konfiguriert.",
    hermesInstallEffectNetwork:
      "Das Skript von der offiziellen Hermes-Installationsadresse herunterladen und Quellcode, Laufzeiten sowie Abhängigkeiten abrufen.",
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
    checking: "Wird geprüft…",
    cachedSuffix: " (zwischengespeichert)",
    refreshFailedSuffix: "; Aktualisierung fehlgeschlagen: {{error}}",
    unavailable: "Nicht verfügbar",
    managementComingSoon:
      "Installations- und Updateaktionen werden später hinzugefügt.",
    prepareFailed: "Aktion konnte nicht vorbereitet werden: {{error}}",
    taskRunning:
      "Für dieses Tool läuft eine Aufgabe. Öffne „Aufgaben“ in der Seitenleiste, um sie zu verfolgen.",
    launchMethod: "Startmethode",
    launchHintMac:
      "Der automatische Modus verwendet immer Terminal.app. Terminals von Drittanbietern werden nur bei ausdrücklicher Auswahl verwendet.",
    launchHintWindows:
      "Ein Windows-Terminalprofil wird bevorzugt; falls nicht verfügbar, wird auf eine eigenständige Shell zurückgegriffen.",
    launchHintLinux:
      "Im automatischen Modus wird zuerst das Standardterminal der Desktopumgebung verwendet. Du kannst auch manuell ein erkanntes Terminal auswählen.",
    launchHintOther:
      "Verfügbare Terminalstartmethoden für die aktuelle Plattform erkennen.",
    refreshTerminal: "Terminalumgebung erneut erkennen",
    detectingTerminal: "Terminalumgebung wird erkannt…",
    launchLoadFailed: "Startmethoden konnten nicht geladen werden: {{error}}",
    autoSelect: "Automatisch",
    autoDescriptionMac:
      "Immer Terminal.app verwenden. Die Installation eines Drittanbieterterminals ändert die Standardeinstellung nicht.",
    autoDescriptionWindows:
      "Zuerst das Standardprofil von Windows Terminal verwenden, dann auf PowerShell 7, Windows PowerShell und CMD zurückgreifen.",
    autoDescriptionLinux:
      "Zuerst über xdg-terminal-exec das Standardterminal der Desktopumgebung verwenden, danach der Reihe nach auf erkannte Terminals zurückgreifen.",
    recommended: "Empfohlen",
    unknownVersion: "Unbekannte Version",
    noProfiles:
      "Keine auswählbaren Profile gefunden. Im automatischen Modus wird trotzdem das Standardprofil versucht.",
    defaultProfile: "Standardprofil",
    standaloneConsole: "Eigenständige Konsolen",
    standaloneDescription: "Kein Windows-Terminalprofil verwenden",
    fallbackPriority: "Ausweichpriorität {{priority}}",
    standaloneWindow: "Eigenständiges Fenster",
    macTerminals: "macOS-Terminals",
    linuxTerminals: "Linux-Terminals",
    detectedCount_one: "{{count}} erkannt",
    detectedCount_other: "{{count}} erkannt",
    noTerminals:
      "Kein verfügbares Terminal erkannt. Der automatische Start ist derzeit nicht verfügbar.",
    systemDefault: "Systemstandard",
    native: "Nativ",
    unavailableSavedTarget:
      "Das gespeicherte Startziel {{target}} ist auf dieser Plattform nicht verfügbar. Beim Start wird auf das empfohlene Terminal zurückgegriffen. Wähle ein verfügbares Terminal aus, um diese Einstellung zu aktualisieren.",
    saveLaunchFailed: "Startmethode konnte nicht gespeichert werden: {{error}}",
    closeBehavior: "Verhalten beim Schließen des Fensters",
    closeDescriptionMac:
      "Standardmäßig läuft die App nach dem Schließen im Hintergrund weiter. Über das Dock-Symbol oder die Menüleiste kannst du sie erneut anzeigen.",
    closeDescriptionOther:
      "Standardmäßig bleibt die App nach dem Schließen im Infobereich aktiv. Doppelklicke auf das Symbol, um sie erneut anzuzeigen.",
    closeMinimize: "Im Hintergrund weiterlaufen",
    closeQuit: "Anwendung beenden",
    saveFailed: "Speichern fehlgeschlagen: {{error}}",
    configBackup: "Konfigurationssicherung",
    configBackupDescription:
      "Projektverzeichnisse und Notizen exportieren oder importieren. Beim Import werden Einträge anhand des Pfads zusammengeführt, ohne Verzeichnisse zu duplizieren.",
    exportFile: "In Datei exportieren",
    importFile: "Aus Datei importieren",
    exported: "Exportiert.",
    exportFailed: "Export fehlgeschlagen: {{error}}",
    importSuccess: "Erfolgreich importiert.",
    importFailed: "Import fehlgeschlagen: {{error}}",
    diagnostics: "Diagnose",
    exportDiagnostics: "Diagnosebericht exportieren",
    recentLaunch: "Letzte Starts",
    launchHistoryRetention: "Verlauf aufbewahren",
    launchHistoryRetentionCount: "Letzte {{count}} Starts",
    launchHistoryProject: "Projekt: ",
    launchHistoryPath: "Pfad: ",
    launchHistoryTime: "Zeit: ",
    launchHistorySessionId: "Sitzungs-ID: ",
    clearHistory: "Verlauf löschen",
    resumeSession: "Sitzung fortsetzen",
    newSession: "Neue Sitzung",
    success: "Erfolgreich",
    failed: "Fehlgeschlagen",
    cache: "Cache",
    entries: "Einträge: {{count}}",
    size: "Größe: {{size}}",
    newestWrite: "Letzter Schreibvorgang: {{time}}",
    clearCache: "Cache leeren",
    recovery: "Datenwiederherstellung",
    recoveryDescription:
      "Vor Importen und Wiederherstellungen werden automatisch Wiederherstellungspunkte angelegt. Manuelle Wiederherstellungspunkte sichern alle aktuellen Anwendungsdaten.",
    createRecovery: "Wiederherstellungspunkt erstellen",
    readRecoveryFailed:
      "Wiederherstellungspunkte konnten nicht gelesen werden: {{error}}",
    restore: "Wiederherstellen",
    confirmRestore: "Daten wiederherstellen?",
    restoreDescription:
      "Daten auf den Stand vom {{time}} zurücksetzen. Der aktuelle Stand wird vorher automatisch gesichert.",
    confirmRestoreAction: "Wiederherstellen",
    restoreFailed: "Wiederherstellung fehlgeschlagen: {{error}}",
    restoreBlockedPtys: "{{count}} laufende Terminalsitzung(en)",
    restoreBlockedDirtyFiles:
      "{{count}} Dokument(e) mit ungespeicherten Änderungen",
    restoreBlockedDetachedWindows: "{{count}} abgetrennte Inhaltsfenster",
    backupReason: {
      manual: "Manueller Wiederherstellungspunkt",
      pre_import: "Automatische Sicherung vor dem Import",
      pre_restore: "Schutzsicherung vor der Wiederherstellung",
      pre_migration: "Automatische Sicherung vor dem Upgrade",
    },
    preservation: {
      exact: "Vollständig erhalten",
      command_continuation: "Befehlsfortsetzung",
      appearance_only: "Nur Darstellung",
    },
    shell: { custom: "Benutzerdefinierte Shell" },
    terminalDescription: {
      command_document:
        "Einmalige, sich selbst löschende .command-Datei über LaunchServices öffnen",
      apple_script:
        "Mit AppleScript ein natives Ghostty-Fenster erstellen und den Befehl eingeben",
      direct_arguments:
        "Strukturierte Argumente über die offizielle CLI im App-Bundle übergeben",
      kittySuffix: ", Fenster nach Ende des Befehls geöffnet lassen",
      xdg_terminal_exec:
        "Start an das Standardterminal der Desktopumgebung delegieren (xdg-terminal-exec)",
      shell_wrapped: "Befehl mit dem -e-Flag in einem neuen Fenster ausführen",
    },
  },
  about: {
    title: "Über",
    version: "Version {{version}}",
    description:
      "Ein projektzentrierter Desktoparbeitsbereich für fünf KI-CLIs mit eingebettetem Mehrfenster-Terminal, Sitzungsverlauf und Wiederherstellung sowie wiederverwendbaren Arbeitsbereichlayouts.",
    supportedCli: "Unterstützte CLIs",
    repository: "Projekt-Repository",
    repositoryDescription:
      "Quellcode und Neuigkeiten zu CLI Launchpad ansehen.",
    openRepository: "Auf GitHub ansehen",
    openRepositoryError:
      "Das GitHub-Repository konnte nicht im Standardbrowser geöffnet werden.",
    licenses: "Open-Source-Lizenzen",
    licenseIntro:
      "CLI Launchpad und die enthaltenen Markenicons stehen unter der MIT-Lizenz. Die enthaltenen Schriftarten unterliegen weiterhin jeweils der SIL Open Font License 1.1.",
  },
  executions: {
    title: "Aufgaben",
    description:
      "Live-Ausgaben und Verlauf von Installations- und Updateaufgaben ansehen.",
    operationInstall: "Installation",
    operationUpdate: "Aktualisierung",
    taskToastTitle: "{{tool}} {{operation}}",
    taskSucceededToast: "{{title}} erfolgreich",
    taskFailedToast: "{{title}} fehlgeschlagen",
    taskStoppedToast: "{{title}} angehalten",
    refresh: "Aufgaben aktualisieren",
    clearHistory: "Verlauf löschen",
    clearAllTitle: "Alle abgeschlossenen Aufgaben löschen?",
    clearAllDescription:
      "{{count}} Aufgaben und ihre Protokolle werden endgültig gelöscht.",
    clearing: "Wird gelöscht…",
    confirmClear: "Aufgaben löschen",
    readFailed: "Aufgaben konnten nicht gelesen werden: {{error}}",
    operationFailed: "Aktion fehlgeschlagen: {{error}}",
    listLabel: "Aufgabenliste",
    readingTasks: "Aufgaben werden geladen…",
    emptyTitle: "Noch keine Aufgaben",
    emptyDescription:
      "Installiere oder aktualisiere eine CLI in den Einstellungen. Die Aufgabe wird hier angezeigt.",
    install: "Installieren",
    update: "Aktualisieren",
    selectTask: "Wähle eine Aufgabe aus, um ihre Protokolle anzusehen.",
    source: "Quelle: {{source}}",
    cancelling: "Wird angehalten",
    cancelTask: "Aufgabe anhalten",
    clearRecord: "Eintrag löschen",
    cancelTitle: "Diese Aufgabe anhalten?",
    cancelDescription:
      "Der gesamte Prozessbaum wird beendet. Bei einem unterbrochenen Update muss die CLI möglicherweise neu installiert werden.",
    requesting: "Anfrage wird gesendet…",
    confirmCancel: "Anhalten bestätigen",
    deleteTitle: "Diesen Aufgabeneintrag löschen?",
    deleteDescription:
      "Der zugehörige Protokollverlauf wird ebenfalls endgültig gelöscht.",
    deleting: "Wird gelöscht…",
    confirmDelete: "Löschen bestätigen",
    startedAt: "Gestartet um {{time}}",
    exitCode: "Exitcode {{code}}",
    followOutput: "Neuester Ausgabe folgen",
    readingLogs: "Protokolle werden geladen…",
    noOutput: "(Noch keine Ausgabe)",
    truncated:
      "Das Protokoll hat die Grenze von 1 MiB erreicht. Weitere Ausgaben wurden nicht gespeichert.",
    status: {
      preparing: "Wird vorbereitet",
      running: "Wird ausgeführt",
      cancelling: "Wird angehalten",
      succeeded: "Erfolgreich abgeschlossen",
      failed: "Fehlgeschlagen",
      cancelled: "Abgebrochen",
      timed_out: "Zeitüberschreitung",
      interrupted: "Unerwartet unterbrochen",
    },
    stream: {
      stdout: "Ausgabe",
      stderr: "Fehler",
      system: "System",
    },
  },
  workspaceFiles: {
    rightPanelTabs: "Register der rechten Seitenleiste",
    files: "Dateien",
    git: "Git",
    gitLater:
      "Die Git-Verwaltung wird in einem späteren Meilenstein verfügbar.",
    projectRoot: "Projektstamm",
    refresh: "Aktualisieren",
    showHidden: "Versteckte Dateien anzeigen",
    emptyDirectory: "Dieser Ordner ist leer",
    symlinkDisabled: "Symbolische Links können noch nicht geöffnet werden",
    ignored: "Ignoriert",
    closeFile: "Datei schließen",
    closeFileNamed: "{{name}} schließen",
    fileMenu: "Dateifenstermenü",
    closeOthers: "Andere Inhalte in diesem Bereich schließen ({{count}})",
    closeAllInPane: "Alle Inhalte in diesem Bereich schließen ({{count}})",
    splitAndMoveRight: "Rechts teilen und diese Datei verschieben",
    splitAndMoveDown: "Unten teilen und diese Datei verschieben",
    discardChanges:
      "Diese Datei enthält nicht gespeicherte Änderungen. Schließen und verwerfen?",
    save: "Speichern",
    reload: "Neu laden",
    saveConflict:
      "Die Datei auf dem Datenträger wurde geändert. Deine Änderungen bleiben erhalten. Lade die Datei vor dem erneuten Speichern neu.",
    directoryLimitReached:
      "Zu viele Einträge. Die ersten 5.000 werden angezeigt.",
    directoryEntriesSkipped:
      "{{count}} Einträge konnten nicht angezeigt werden.",
    projectIdentityChanged:
      "Das Projektverzeichnis hat sich geändert. Dieses Dokument ist veraltet; kopiere den Inhalt vor dem Schließen.",
    loadingFile: "Datei wird geladen…",
    editorUnavailable: "Der Texteditor ist derzeit nicht verfügbar.",
    fileCannotOpen: "Diese Datei kann hier nicht geöffnet werden",
    imagePreview: "Bildvorschau",
    unsupported: {
      binary: "Der Texteditor unterstützt keine Binärdateien.",
      tooLarge: "Die Datei überschreitet die Vorschaugrößenbegrenzung.",
      invalidImage: "Die Bilddaten stimmen nicht mit der Dateiendung überein.",
      unsupportedImage: "Dieses Bildformat wird nicht unterstützt.",
    },
  },
} satisfies LocaleShape<typeof en>;
