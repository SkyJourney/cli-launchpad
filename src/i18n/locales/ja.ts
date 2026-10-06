import type { en } from "./en";

type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const ja = {
  common: {
    back: "戻る",
    browse: "参照",
    cancel: "キャンセル",
    confirm: "確認",
    save: "保存",
    copy: "コピー",
    more: "その他",
    loading: "読み込み中…",
    none: "（なし）",
  },
  sidebar: {
    projects: "プロジェクト",
    collapse: "サイドバーを折りたたむ",
    expand: "サイドバーを展開",
    addProject: "プロジェクトを追加",
    searchProjects: "プロジェクト名で検索",
    projectActions: "{{name}} の操作",
    renameProject: "プロジェクト名を変更",
    pinProject: "プロジェクトをピン留め",
    unpinProject: "プロジェクトのピン留めを解除",
    openProjectFolder: "プロジェクトフォルダーを開く",
    removeProject: "プロジェクトを削除",
    confirmRemoveProject:
      "プロジェクト「{{name}}」を削除しますか？ディスク上のファイルは削除されません。",
    pinProjectFailed: "プロジェクトのピン留めに失敗しました: {{error}}",
    reorderProjectsFailed: "プロジェクトの並べ替えに失敗しました: {{error}}",
    openProjectFolderFailed:
      "プロジェクトフォルダーを開けませんでした: {{error}}",
    removeProjectFailed: "プロジェクトを削除できませんでした: {{error}}",
    noProjects: "プロジェクトはまだありません。追加して開始しましょう。",
    noMatchingProjects: "一致するプロジェクトはありません。",
    executions: "タスク",
    settings: "設定",
    about: "このアプリについて",
    activeTasks_one: "実行中のタスク {{count}} 件",
    activeTasks_other: "実行中のタスク {{count}} 件",
    managedCliSessions_one: "{{tool}}、管理中のセッション {{count}} 件",
    managedCliSessions_other: "{{tool}}、管理中のセッション {{count}} 件",
  },
  theme: {
    current: "テーマ: {{mode}}",
    select: "テーマを選択",
    light: "ライト",
    dark: "ダーク",
    system: "システム設定に従う",
  },
  language: {
    current: "言語: {{language}}",
    select: "言語を選択",
    zh: "简体中文",
    en: "English",
  },
  appExit: {
    title: "CLI Launchpad を終了しますか？",
    description:
      "{{count}} 個の埋め込みターミナルセッションが実行中です。終了すると、これらのセッションと子プロセスも終了します。",
    confirm: "セッションを終了してアプリを閉じる",
    unsavedDescription: "未保存の変更があるファイル：{{count}} 件",
    confirmDiscard: "変更を破棄して終了",
    terminating: "終了しています…",
  },
  windowChrome: {
    titlebar: "アプリケーションのタイトルバー",
    minimize: "最小化",
    maximize: "最大化",
    restore: "元に戻す",
    close: "ウィンドウを閉じる",
  },
  pty: {
    panelLabel: "埋め込みターミナル",
    paneLabel: "ターミナルペイン",
    paneNumber: "ペイン {{number}}",
    paneSessions: "このペインのターミナルセッション",
    inputBackpressure:
      "ターミナル入力キューがいっぱいです。少し待ってから再試行してください。",
    layoutLoading: "ワークスペースを復元しています…",
    layoutNeedsReset:
      "ワークスペースのレイアウトを読み込めませんでした（{{reason}}）。元のデータは保持され、自動保存は一時停止しています。",
    layoutLoadFailed:
      "ワークスペースのレイアウトを読み込めませんでした: {{error}}。今回の実行では元のデータを上書きしません。",
    retryLayoutRead: "再読み込み",
    resetLayout: "ワークスペースのレイアウトをリセット",
    layoutResetPending: "リセットしています…",
    confirmLayoutReset:
      "ワークスペースのレイアウトを読み込めません。リセットすると、破損したレイアウトは空のワークスペースに置き換えられます。続行しますか？",
    layoutResetFailed: "ワークスペースをリセットできませんでした: {{error}}",
    layoutSaveFailed:
      "ワークスペースを自動保存できませんでした: {{error}}。ターミナルは引き続き利用できます。",
    layouts: "レイアウト",
    namedLayouts: "名前付きレイアウト",
    layoutNamePlaceholder: "レイアウト名",
    saveLayout: "現在のレイアウトを保存",
    applyLayout: "適用",
    layoutApplied:
      "レイアウトを適用しました。実行中のセッションは保持されています",
    renameLayout: "レイアウト名を変更",
    overwriteLayout: "現在のレイアウトで上書き",
    deleteLayout: "レイアウトを削除",
    layoutSaved: "レイアウトを保存しました",
    layoutRenamed: "レイアウト名を変更しました",
    layoutOverwritten: "レイアウトを更新しました",
    layoutDeleted: "レイアウトを削除しました",
    layoutActionFailed: "レイアウト操作に失敗しました: {{error}}",
    layoutChangedDuringApply:
      "レイアウトの適用中にワークスペースが変更されました。もう一度お試しください。",
    layoutPresetMissing:
      "この名前付きレイアウトは存在しません。リストを更新して、もう一度お試しください。",
    layoutsLoading: "レイアウトを読み込んでいます…",
    noNamedLayouts: "保存済みのレイアウトはありません。",
    confirmOverwriteLayout:
      "現在のペインとセッションで「{{name}}」を上書きしますか？",
    confirmDeleteLayout: "「{{name}}」を削除しますか？",
    closeLayoutManager: "レイアウト管理を閉じる",
    confirmLayoutAction: "確認",
    projectUnavailable:
      "このプロジェクトが見つからないため、ターミナルを起動できません。",
    restoredEnded:
      "このセッションは終了しています。CLI は自動起動しません。後でセッション履歴から復元してください。",
    restoredMissingProject:
      "このセッションに関連付けられたプロジェクトは存在しません。",
    restoredProjectMismatch:
      "プロジェクトのパスまたは識別情報が変更されたため、このセッションが属するプロジェクトを確認できません。",
    restoredMissingSession: "セッションの記録は存在しません。",
    restoredSessionMismatch:
      "このセッションは、現在このプロジェクトまたは CLI に関連付けられていません。",
    previousSessions: "前の項目 {{count}} 件",
    nextSessions: "後の項目 {{count}} 件",
    previousSessionsHeading: "前の項目",
    nextSessionsHeading: "後の項目",
    overflowContents: "非表示の項目 {{count}} 件",
    overflowContentsHeading: "非表示の項目",
    emptyPane: "空のペイン",
    empty:
      "右側からセッションを復元するか、このペインでファイルを開くか CLI を起動してください。",
    starting: "ターミナルセッションを作成しています…",
    terminalNotReady:
      "ターミナルはまだ準備中です。少し待ってからもう一度お試しください。",
    close: "ターミナルセッションを閉じる",
    closeNamed: "{{name}} を閉じる",
    sessionMenu: "ターミナルセッションメニュー",
    closeEmptyPane: "空のペインを閉じる",
    splitRight: "右に分割",
    splitDown: "下に分割",
    splitAndMoveRight: "右に分割して、このターミナルを移動",
    splitAndMoveDown: "下に分割して、このターミナルを移動",
    moveToPane: "ペインに移動",
    dropIntoPane: "{{pane}} にドロップして移動",
    openSeparateWindow: "別ウィンドウで開く",
    returnToWorkspace: "ワークスペースに戻る",
    returningToWorkspace: "ワークスペースに戻しています…",
    returnFailed: "ワークスペースに戻れませんでした: {{error}}",
    returnTimedOut: "メインワークスペースから時間内に応答がありませんでした。",
    detachedDefaultTitle: "CLI ターミナル",
    detachedMoveUnavailable: "このターミナルは別ウィンドウに移動できません。",
    detachedMoveNotRunning:
      "実行中のターミナルのみ別ウィンドウに移動できます。",
    detachedStartTimedOut: "別ウィンドウの起動がタイムアウトしました。",
    detachedCreateFailed: "別のターミナルウィンドウを作成できませんでした。",
    detachedStartFailed: "別のターミナルウィンドウを起動できませんでした。",
    detachedStateChanged:
      "別ウィンドウの状態が変更されました。もう一度お試しください。",
    detachedSessionMissing:
      "このターミナルセッションはメインワークスペースに見つかりません。",
    workspaceRestoring:
      "メインワークスペースはターミナルを復元中です。少し待ってからもう一度お試しください。",
    detachedExitedBeforeReady:
      "別ウィンドウが制御を引き継ぐ前に PTY が終了しました。",
    detachedClosedBeforeReady:
      "別ウィンドウが制御を引き継ぐ前に閉じられました。",
    layoutDataMissing:
      "レイアウトは準備完了とされましたが、レイアウトデータが返されませんでした。",
    namedLayoutMissing:
      "この名前付きレイアウトは存在しません。リストを更新して、もう一度お試しください。",
    closeCurrent: "このターミナルを閉じる",
    closeOthers: "ペイン内の他の項目を閉じる（{{count}}）",
    closeAllInPane: "ペイン内のすべての項目を閉じる（{{count}}）",
    splitTooSmall:
      "再分割するには、ペインの{{axis}}が少なくとも {{size}} px 必要です。",
    width: "幅",
    height: "高さ",
    confirmClose: "このターミナルセッションと子プロセスを終了しますか？",
    confirmCloseMany:
      "これら {{count}} 件のターミナルセッションと子プロセスを終了しますか？",
    closePending:
      "{{count}} 件のターミナルセッションは起動中のため、まだ閉じられません。",
    closeFailedMany:
      "{{count}} 件のターミナルセッションを閉じられませんでした。該当するターミナルの詳細を確認してください。",
    status: {
      running: "実行中",
      exited: "終了",
      terminated: "強制終了",
      failed: "失敗",
    },
  },
  cliStatus: {
    available: "インストール済み",
    availableTitle: "インストール済みで起動できます",
    missing: "見つかりません",
    missingTitle: "見つかりません。設定を開いてインストールしてください",
    unknown: "確認に失敗しました",
    unknownTitle:
      "確認に失敗しました。更新して再試行してください。起動とインストールは無効です",
  },
  time: {
    neverStarted: "未起動",
    unknown: "不明な時刻",
  },
  projects: {
    title: "プロジェクト",
    searchPlaceholder: "プロジェクト名で検索",
    sortRecent: "最近使用した順",
    sortName: "名前",
    refreshCli: "CLI を再検出",
    addDirectory: "ディレクトリを追加",
    chooseDirectory: "プロジェクトディレクトリを選択",
    namePlaceholder: "名前",
    pathPlaceholder: "フルパスを入力するか、参照を選択",
    addFailed: "ディレクトリを追加できませんでした: {{error}}",
    launchFailed: "起動に失敗しました: {{error}}",
    openPathFailed: "ディレクトリを開けませんでした: {{error}}",
    empty:
      "一致するディレクトリはありません。「ディレクトリを追加」を選択して作成してください。",
  },
  emptyProjects: {
    title: "プロジェクトを選択して開始",
    description:
      "ローカルプロジェクトを追加すると、そのワークスペースで CLI セッションを起動・切り替えできます。",
    addProject: "プロジェクトを追加",
  },
  projectDialog: {
    addTitle: "プロジェクトを追加",
    editTitle: "プロジェクトを編集",
    name: "プロジェクト名",
    directory: "プロジェクトディレクトリ",
    chooseDirectory: "ディレクトリを選択",
    chooseFailed: "プロジェクトディレクトリを選択できませんでした: {{error}}",
    note: "メモ",
    notePlaceholder: "プロジェクトに関する任意のメモ",
    loading: "プロジェクトの詳細を読み込んでいます…",
    saving: "保存しています…",
    saveFailed: "プロジェクトを保存できませんでした: {{error}}",
  },
  projectDetail: {
    noDirectory: "ディレクトリが選択されていません。",
    context: "プロジェクトのコンテキスト",
    cliLaunchers: "CLI を起動",
    showContextPanel: "プロジェクトコンテキストを表示",
    hideContextPanel: "プロジェクトコンテキストを非表示",
    openDirectory: "ディレクトリを開く",
    openPathFailed: "ディレクトリを開けませんでした: {{error}}",
    launchTool: "埋め込みターミナルで {{tool}} を起動",
    sessions: "セッション履歴",
    searchSessions: "セッションを検索",
    searchPlaceholder: "セッションのタイトル、要約、別名を検索",
    clearSearch: "検索をクリア",
    searchIncomplete:
      "一部のセッションソースを完全に検索できませんでした: {{tools}}",
    searchFailed: "セッションの検索に失敗しました: {{error}}",
    noSearchResults: "一致するセッションはありません。",
    resumeEmbedded: "再開",
    refreshSessions: "セッションを更新",
    sessionsFailed: "セッションを読み込めませんでした: {{error}}",
    reading: "読み込み中…",
    aliasRequired: "セッションの別名を入力してください",
    sessionAlias: "セッションの別名",
    originalTitle: "元のタイトル: {{title}}",
    customTitle: "カスタムタイトル",
    saveAlias: "セッションの別名を保存",
    cancelRename: "名前の変更をキャンセル",
    renameSession: "セッション名を変更",
    restoreOriginal: "元のタイトルに戻す",
    restore: "再開",
    loadMoreFailed: "続きを読み込めませんでした: {{error}}",
    noSessions: "セッション履歴はありません。",
  },
  settings: {
    title: "設定",
    refresh: "再検出",
    cliStatus: "CLI の状態",
    detectFailed: "検出に失敗しました: {{error}}",
    updateAvailable: "更新があります",
    taskActiveTitle: "インストールまたは更新タスクがすでに実行中です",
    preparing: "準備中…",
    install: "インストール",
    update: "更新",
    grokInstallEffectsHeading: "公式インストーラーは次の操作を行います:",
    grokInstallEffectPath:
      "現在のユーザーのプロファイル内の .grok\\bin、または GROK_BIN_DIR が設定されている場合はその場所にインストールします。",
    grokInstallEffectChannel:
      "Launchpad は安定版チャンネルを固定し、継承した環境設定によってプレリリース版やエンタープライズチャンネルが選択されないようにします。",
    grokInstallEffectFiles:
      "grok.exe と agent.exe をダウンロードしてインストールし、既存ファイルを置き換えます。現在のユーザーのプロファイルにある .grok\\config.toml の CLI インストーラーマーカーを作成または更新し、PowerShell 補完を生成します。",
    grokInstallEffectPathEnv:
      "インストールディレクトリがまだ PATH にない場合、現在のユーザーの PATH に追加します。",
    grokInstallEffectNetwork:
      "x.ai からバージョン情報とバイナリを取得し、Google Cloud Storage を代替元として使用します。環境に GROK_DEPLOYMENT_KEY がある場合は、デプロイ設定も取得して管理対象の設定ファイルに書き込みます。",
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
      "Grok Build のインストール元を確認するため、まずバージョン情報を更新してください。",
    installing: "インストール中…",
    updating: "更新中…",
    refreshingVersion: "バージョンを更新中…",
    refreshingVersionTitle: "更新後の CLI バージョンを読み込んでいます",
    refreshingVersionDescription:
      "タスクが終了しました。更新後のバージョン状態を確認しています。",
    confirmInstall: "インストールを確認",
    confirmUpdate: "更新を確認",
    creatingTask: "タスクを作成中…",
    confirmRun: "実行",
    source: "ソース: {{source}}",
    commandNotice:
      "このコマンドはコンピューター上で実行されます。確認後、「タスク」でライブログを確認できます。",
    executeFailed: "実行に失敗しました: {{error}}",
    path: "パス: {{path}}",
    current: "現在: ",
    latest: "最新: ",
    unavailableWithError: "利用できません（{{error}}）",
    unknownRefresh: "不明です。右上から再検出してください",
    hermesRefreshPrompt: "main ブランチを確認するには手動で更新してください",
    hermesUpToDate: "main の最新状態です",
    hermesUpdateBehind: "main より {{count}} コミット遅れています",
    hermesUpdateBehindUnknown: "main に更新があります（コミット数は不明）",
    hermesUpdateStatus: "更新状態: ",
    hermesInstallEffectsHeading: "公式インストーラーは次の操作を行います:",
    hermesInstallEffectRuntime:
      "現在のユーザー向けに Hermes CLI、管理対象の Python/Node ランタイム、依存関係をインストールします。",
    hermesInstallEffectData:
      "%LOCALAPPDATA%\\hermes にソース、設定、ユーザーデータを準備します。既存データは公式インストーラーが処理します。",
    hermesInstallEffectPath:
      "%LOCALAPPDATA%\\hermes\\bin が未設定の場合、現在のユーザーの PATH に追加します。",
    hermesInstallEffectNetwork:
      "公式 Hermes インストーラーのアドレスからスクリプトをダウンロードし、ソース、ランタイム、依存関係を取得します。",
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
    checking: "確認中…",
    cachedSuffix: "（キャッシュ済み）",
    refreshFailedSuffix: "。更新に失敗しました: {{error}}",
    unavailable: "利用できません",
    managementComingSoon: "インストールと更新の操作は後の段階で追加されます。",
    prepareFailed: "操作を準備できませんでした: {{error}}",
    taskRunning:
      "このツールのタスクが実行中です。サイドバーから「タスク」を開いて確認してください。",
    launchMethod: "起動方法",
    launchHintMac:
      "自動モードでは常に Terminal.app を使用します。サードパーティ製ターミナルは明示的に選択した場合のみ使用します。",
    launchHintWindows:
      "Windows Terminal のプロファイルを優先し、利用できない場合は独立したシェルにフォールバックします。",
    launchHintLinux:
      "自動モードではデスクトップの既定ターミナルを優先します。検出されたターミナルを手動で選択することもできます。",
    launchHintOther:
      "現在のプラットフォームで利用可能なターミナル起動方法を検出します。",
    refreshTerminal: "ターミナル環境を再検出",
    detectingTerminal: "ターミナル環境を検出中…",
    launchLoadFailed: "起動方法を読み込めませんでした: {{error}}",
    autoSelect: "自動",
    autoDescriptionMac:
      "常に Terminal.app を使用します。サードパーティ製ターミナルをインストールしても既定の動作は変わりません。",
    autoDescriptionWindows:
      "Windows Terminal の既定プロファイルを優先し、その後 PowerShell 7、Windows PowerShell、CMD の順にフォールバックします。",
    autoDescriptionLinux:
      "まず xdg-terminal-exec でデスクトップの既定ターミナルに委譲し、検出順にフォールバックします。",
    recommended: "推奨",
    unknownVersion: "不明なバージョン",
    noProfiles:
      "選択可能なプロファイルが見つかりません。自動モードでは既定プロファイルも試します。",
    defaultProfile: "既定のプロファイル",
    standaloneConsole: "独立コンソール",
    standaloneDescription: "Windows Terminal のプロファイルを使用しない",
    fallbackPriority: "フォールバック優先度 {{priority}}",
    standaloneWindow: "独立ウィンドウ",
    macTerminals: "macOS ターミナル",
    linuxTerminals: "Linux ターミナル",
    detectedCount_one: "{{count}} 件を検出",
    detectedCount_other: "{{count}} 件を検出",
    noTerminals:
      "利用可能なターミナルが見つかりません。現在、自動起動は利用できません。",
    systemDefault: "システムの既定値",
    native: "ネイティブ",
    unavailableSavedTarget:
      "保存済みの起動先 {{target}} はこのプラットフォームで利用できません。起動時は推奨ターミナルにフォールバックします。利用可能なターミナルを選択すると設定を更新できます。",
    saveLaunchFailed: "起動方法を保存できませんでした: {{error}}",
    closeBehavior: "ウィンドウを閉じたときの動作",
    closeDescriptionMac:
      "既定では、閉じてもアプリはバックグラウンドで実行されます。Dock アイコンまたはメニューバーから再表示できます。",
    closeDescriptionOther:
      "既定では、閉じてもアプリはシステムトレイで実行されます。トレイアイコンをダブルクリックすると再表示できます。",
    closeMinimize: "バックグラウンドで実行し続ける",
    closeQuit: "アプリを終了",
    saveFailed: "保存に失敗しました: {{error}}",
    configBackup: "設定のバックアップ",
    configBackupDescription:
      "プロジェクトディレクトリとメモをエクスポートまたはインポートします。インポート時はパスで統合し、ディレクトリを重複追加しません。",
    exportFile: "ファイルにエクスポート",
    importFile: "ファイルからインポート",
    exported: "エクスポートしました。",
    exportFailed: "エクスポートに失敗しました: {{error}}",
    importSuccess: "インポートしました。",
    importFailed: "インポートに失敗しました: {{error}}",
    diagnostics: "診断",
    exportDiagnostics: "診断レポートをエクスポート",
    recentLaunch: "最近の起動",
    launchHistoryRetention: "履歴を保持",
    launchHistoryRetentionCount: "直近 {{count}} 件",
    launchHistoryProject: "プロジェクト: ",
    launchHistoryPath: "パス: ",
    launchHistoryTime: "時刻: ",
    launchHistorySessionId: "セッション ID: ",
    clearHistory: "履歴をクリア",
    resumeSession: "セッションを再開",
    newSession: "新しいセッション",
    success: "成功",
    failed: "失敗",
    cache: "キャッシュ",
    entries: "項目数: {{count}}",
    size: "サイズ: {{size}}",
    newestWrite: "最終書き込み: {{time}}",
    clearCache: "キャッシュをクリア",
    recovery: "データ復旧",
    recoveryDescription:
      "インポートと復元の前に自動復元ポイントを作成します。手動復元ポイントには現在のアプリデータ全体が保存されます。",
    createRecovery: "復元ポイントを作成",
    readRecoveryFailed: "復元ポイントを読み込めませんでした: {{error}}",
    restore: "復元",
    confirmRestore: "データを復元しますか？",
    restoreDescription:
      "{{time}} 時点のデータに復元します。実行前に現在の状態を自動保存します。",
    confirmRestoreAction: "復元を実行",
    restoreFailed: "復元に失敗しました: {{error}}",
    restoreBlockedPtys: "実行中のターミナルセッション {{count}} 件",
    restoreBlockedDirtyFiles: "未保存の変更があるドキュメント {{count}} 件",
    restoreBlockedDetachedWindows:
      "分離されたコンテンツウィンドウ {{count}} 個",
    backupReason: {
      manual: "手動復元ポイント",
      pre_import: "インポート前の自動バックアップ",
      pre_restore: "復元前の保護バックアップ",
      pre_migration: "アップグレード前の自動バックアップ",
    },
    preservation: {
      exact: "完全に保持",
      command_continuation: "コマンドの継続",
      appearance_only: "外観のみ",
    },
    shell: { custom: "カスタムシェル" },
    terminalDescription: {
      command_document:
        "LaunchServices で一度だけ実行され、自動削除される .command を開く",
      apple_script:
        "AppleScript で Ghostty のネイティブウィンドウを作成し、コマンドを入力",
      direct_arguments: "アプリバンドル内の公式 CLI に構造化引数を渡す",
      kittySuffix: "。コマンド終了後もウィンドウを開いたままにする",
      xdg_terminal_exec:
        "デスクトップの既定ターミナルに委譲して起動（xdg-terminal-exec）",
      shell_wrapped: "-e オプションで新しいウィンドウにコマンドを渡す",
    },
  },
  about: {
    title: "このアプリについて",
    version: "バージョン {{version}}",
    description:
      "5 つの AI CLI、埋め込みマルチペインターミナル、セッション履歴と復元、再利用可能なワークスペースレイアウトを備えたプロジェクト中心のデスクトップワークスペースです。",
    supportedCli: "対応 CLI",
    repository: "プロジェクトリポジトリ",
    repositoryDescription:
      "CLI Launchpad のソースコードとプロジェクトの更新情報を確認します。",
    openRepository: "GitHub で表示",
    openRepositoryError:
      "既定のブラウザーで GitHub リポジトリを開けませんでした。",
    licenses: "オープンソースライセンス",
    licenseIntro:
      "CLI Launchpad と同梱ブランドアイコンは MIT License を使用します。同梱フォントはそれぞれの SIL Open Font License 1.1 に従います。",
  },
  executions: {
    title: "タスク",
    description: "インストールおよび更新タスクのライブ出力と履歴を表示します。",
    operationInstall: "インストール",
    operationUpdate: "更新",
    taskToastTitle: "{{tool}} {{operation}}",
    taskSucceededToast: "{{title}} が成功しました",
    taskFailedToast: "{{title}} が失敗しました",
    taskStoppedToast: "{{title}} を停止しました",
    refresh: "タスクを更新",
    clearHistory: "履歴を消去",
    clearAllTitle: "完了したタスクをすべて削除しますか？",
    clearAllDescription: "{{count}} 件のタスクとログが完全に削除されます。",
    clearing: "削除中…",
    confirmClear: "タスクを消去",
    readFailed: "タスクを読み込めませんでした: {{error}}",
    operationFailed: "操作に失敗しました: {{error}}",
    listLabel: "タスクリスト",
    readingTasks: "タスクを読み込んでいます…",
    emptyTitle: "タスクはありません",
    emptyDescription:
      "設定から CLI をインストールまたは更新すると、ここにタスクが表示されます。",
    install: "インストール",
    update: "更新",
    selectTask: "タスクを選択してログを表示します。",
    source: "ソース: {{source}}",
    cancelling: "停止中",
    cancelTask: "タスクを停止",
    clearRecord: "記録を削除",
    cancelTitle: "このタスクを停止しますか？",
    cancelDescription:
      "プロセスツリー全体を強制終了します。更新を中断すると、CLI の再インストールが必要になる場合があります。",
    requesting: "要求中…",
    confirmCancel: "停止を確認",
    deleteTitle: "このタスク記録を削除しますか？",
    deleteDescription: "関連する過去のログも完全に削除されます。",
    deleting: "削除中…",
    confirmDelete: "削除を確認",
    startedAt: "開始時刻 {{time}}",
    exitCode: "終了コード {{code}}",
    followOutput: "最新の出力に追従",
    readingLogs: "ログを読み込んでいます…",
    noOutput: "（出力はまだありません）",
    truncated:
      "ログが 1 MiB の上限に達したため、以降の出力は保存されませんでした。",
    status: {
      preparing: "準備中",
      running: "実行中",
      cancelling: "停止中",
      succeeded: "成功",
      failed: "失敗",
      cancelled: "キャンセル済み",
      timed_out: "タイムアウト",
      interrupted: "予期せず中断",
    },
    stream: {
      stdout: "出力",
      stderr: "エラー",
      system: "システム",
    },
  },
  workspaceFiles: {
    rightPanelTabs: "右側パネルのタブ",
    files: "ファイル",
    git: "Git",
    gitLater: "Git 管理は後続のマイルストーンで利用可能になります。",
    projectRoot: "プロジェクトルート",
    refresh: "更新",
    showHidden: "隠しファイルを表示",
    emptyDirectory: "このフォルダーは空です",
    symlinkDisabled: "シンボリックリンクはまだ開けません",
    ignored: "除外対象",
    closeFile: "ファイルを閉じる",
    closeFileNamed: "{{name}} を閉じる",
    fileMenu: "ファイルウィンドウメニュー",
    closeOthers: "ペイン内の他の項目を閉じる（{{count}}）",
    closeAllInPane: "ペイン内のすべての項目を閉じる（{{count}}）",
    splitAndMoveRight: "右に分割してこのファイルを移動",
    splitAndMoveDown: "下に分割してこのファイルを移動",
    discardChanges: "未保存の変更があります。閉じて変更を破棄しますか？",
    save: "保存",
    reload: "再読み込み",
    saveConflict:
      "ファイルがディスク上で変更されました。編集内容は保持されています。再読み込みしてから保存してください。",
    directoryLimitReached:
      "項目数が多いため、最初の5,000件のみ表示しています。",
    directoryEntriesSkipped: "{{count}} 件の項目を表示できませんでした。",
    projectIdentityChanged:
      "プロジェクトディレクトリの識別情報が変わりました。このドキュメントは古いため、閉じる前に内容をコピーしてください。",
    loadingFile: "ファイルを読み込み中…",
    editorUnavailable: "テキストエディターは現在利用できません。",
    fileCannotOpen: "このファイルはここでは開けません",
    imagePreview: "画像プレビュー",
    unsupported: {
      binary: "テキストエディターではバイナリファイルを開けません。",
      tooLarge: "ファイルサイズがプレビュー上限を超えています。",
      invalidImage: "画像データとファイル拡張子が一致しません。",
      unsupportedImage: "この画像形式には対応していません。",
    },
  },
} satisfies LocaleShape<typeof en>;
