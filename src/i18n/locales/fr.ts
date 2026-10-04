import type { en } from "./en";

type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const fr = {
  common: {
    back: "Retour",
    browse: "Parcourir",
    cancel: "Annuler",
    save: "Enregistrer",
    copy: "Copier",
    more: "Plus",
    loading: "Chargement…",
    none: "(Aucun)",
  },
  sidebar: {
    projects: "Projets",
    collapse: "Réduire la barre latérale",
    expand: "Développer la barre latérale",
    addProject: "Ajouter un projet",
    searchProjects: "Rechercher un projet par nom",
    projectActions: "Actions pour {{name}}",
    renameProject: "Renommer le projet",
    pinProject: "Épingler le projet",
    unpinProject: "Désépingler le projet",
    openProjectFolder: "Ouvrir le dossier du projet",
    removeProject: "Supprimer le projet",
    confirmRemoveProject:
      "Supprimer le projet « {{name}} » ? Les fichiers sur le disque ne seront pas supprimés.",
    pinProjectFailed: "Impossible d’épingler le projet : {{error}}",
    reorderProjectsFailed: "Impossible de réorganiser les projets : {{error}}",
    openProjectFolderFailed:
      "Impossible d’ouvrir le dossier du projet : {{error}}",
    removeProjectFailed: "Impossible de supprimer le projet : {{error}}",
    noProjects: "Aucun projet pour le moment. Ajoutez-en un pour commencer.",
    noMatchingProjects: "Aucun projet correspondant.",
    executions: "Tâches",
    settings: "Paramètres",
    about: "À propos",
    activeTasks_one: "{{count}} tâche active",
    activeTasks_other: "{{count}} tâches actives",
    managedCliSessions_one: "{{tool}}, {{count}} session gérée",
    managedCliSessions_other: "{{tool}}, {{count}} sessions gérées",
  },
  theme: {
    current: "Thème : {{mode}}",
    select: "Choisir un thème",
    light: "Clair",
    dark: "Sombre",
    system: "Système",
  },
  language: {
    current: "Langue : {{language}}",
    select: "Choisir une langue",
    zh: "简体中文",
    en: "English",
  },
  appExit: {
    title: "Quitter CLI Launchpad ?",
    description:
      "{{count}} session(s) de terminal intégrées sont toujours en cours. Quitter mettra fin à ces sessions et à leurs processus enfants.",
    confirm: "Terminer les sessions et quitter",
    terminating: "Fin des sessions…",
  },
  windowChrome: {
    titlebar: "Barre de titre de la fenêtre de l’application",
    minimize: "Réduire",
    maximize: "Agrandir",
    restore: "Restaurer",
    close: "Fermer la fenêtre",
  },
  pty: {
    panelLabel: "Terminal intégré",
    paneLabel: "Panneau de terminal",
    paneNumber: "Panneau {{number}}",
    paneSessions: "Sessions de terminal dans ce panneau",
    layoutLoading: "Restauration de l’espace de travail…",
    layoutNeedsReset:
      "Impossible de lire la disposition de l’espace de travail ({{reason}}). Les données d’origine sont conservées et l’enregistrement automatique est suspendu.",
    layoutLoadFailed:
      "Impossible de lire la disposition de l’espace de travail : {{error}}. Cette exécution ne remplacera pas les données d’origine.",
    retryLayoutRead: "Réessayer la lecture",
    resetLayout: "Réinitialiser la disposition de l’espace de travail",
    layoutResetPending: "Réinitialisation…",
    confirmLayoutReset:
      "La disposition de l’espace de travail est illisible. La réinitialisation remplacera la disposition endommagée par un espace de travail vide. Continuer ?",
    layoutResetFailed:
      "Impossible de réinitialiser l’espace de travail : {{error}}",
    layoutSaveFailed:
      "Impossible d’enregistrer automatiquement l’espace de travail : {{error}}. Les terminaux restent disponibles.",
    layouts: "Dispositions",
    namedLayouts: "Dispositions nommées",
    layoutNamePlaceholder: "Nom de la disposition",
    saveLayout: "Enregistrer la disposition actuelle",
    applyLayout: "Appliquer",
    layoutApplied:
      "Disposition appliquée ; les sessions en cours ont été conservées",
    renameLayout: "Renommer la disposition",
    overwriteLayout: "Remplacer par la disposition actuelle",
    deleteLayout: "Supprimer la disposition",
    layoutSaved: "Disposition enregistrée",
    layoutRenamed: "Disposition renommée",
    layoutOverwritten: "Disposition mise à jour",
    layoutDeleted: "Disposition supprimée",
    layoutActionFailed: "Échec de l’action sur la disposition : {{error}}",
    layoutChangedDuringApply:
      "L’espace de travail a changé pendant l’application de la disposition. Veuillez réessayer.",
    layoutPresetMissing:
      "Cette disposition nommée n’existe plus. Actualisez la liste et réessayez.",
    layoutsLoading: "Chargement des dispositions…",
    noNamedLayouts: "Aucune disposition enregistrée.",
    confirmOverwriteLayout:
      "Remplacer « {{name}} » par les panneaux et sessions actuels ?",
    confirmDeleteLayout: "Supprimer « {{name}} » ?",
    closeLayoutManager: "Fermer le gestionnaire de dispositions",
    confirmLayoutAction: "Confirmer",
    projectUnavailable:
      "Ce projet est introuvable ; le terminal ne peut donc pas démarrer.",
    restoredEnded:
      "Cette session est terminée. La CLI ne démarrera pas automatiquement ; vous pourrez la restaurer plus tard depuis l’historique des sessions.",
    restoredMissingProject: "Le projet associé à cette session n’existe plus.",
    restoredProjectMismatch:
      "Le chemin ou l’identité du projet a changé. Impossible de confirmer que cette session lui appartient.",
    restoredMissingSession: "L’enregistrement de la session n’existe plus.",
    restoredSessionMismatch:
      "La session n’est plus associée à ce projet ou à cette CLI.",
    previousSessions: "{{count}} sessions précédentes",
    nextSessions: "{{count}} sessions suivantes",
    previousSessionsHeading: "Sessions de terminal précédentes",
    nextSessionsHeading: "Sessions de terminal suivantes",
    emptyPane: "Panneau vide",
    empty:
      "Restaurez une session depuis la droite ou ouvrez un fichier ou démarrez une CLI dans ce panneau.",
    starting: "Création de la session de terminal…",
    terminalNotReady:
      "Le terminal n’est pas encore prêt. Réessayez dans un instant.",
    close: "Fermer la session de terminal",
    closeNamed: "Fermer {{name}}",
    sessionMenu: "Menu de la session de terminal",
    closeEmptyPane: "Fermer le panneau vide",
    splitRight: "Diviser à droite",
    splitDown: "Diviser vers le bas",
    splitAndMoveRight: "Diviser à droite et déplacer ce terminal",
    splitAndMoveDown: "Diviser vers le bas et déplacer ce terminal",
    moveToPane: "Déplacer vers un panneau",
    dropIntoPane: "Déposer pour déplacer vers {{pane}}",
    openSeparateWindow: "Ouvrir dans une fenêtre séparée",
    returnToWorkspace: "Revenir à l’espace de travail",
    returningToWorkspace: "Retour à l’espace de travail…",
    returnFailed: "Impossible de revenir à l’espace de travail : {{error}}",
    returnTimedOut: "L’espace de travail principal n’a pas répondu à temps.",
    detachedDefaultTitle: "Terminal CLI",
    detachedMoveUnavailable:
      "Ce terminal ne peut pas être déplacé dans une fenêtre séparée.",
    detachedMoveNotRunning:
      "Seul un terminal en cours d’exécution peut être déplacé dans une fenêtre séparée.",
    detachedStartTimedOut:
      "Le démarrage de la fenêtre de terminal séparée a expiré.",
    detachedCreateFailed: "Impossible de créer la fenêtre de terminal séparée.",
    detachedStartFailed:
      "Impossible de démarrer la fenêtre de terminal séparée.",
    detachedStateChanged:
      "L’état de la fenêtre séparée a changé. Veuillez réessayer.",
    detachedSessionMissing:
      "Cette session de terminal est introuvable dans l’espace de travail principal.",
    workspaceRestoring:
      "L’espace de travail principal restaure encore les terminaux. Réessayez dans un instant.",
    detachedExitedBeforeReady:
      "Le PTY s’est terminé avant que la fenêtre séparée n’en prenne le contrôle.",
    detachedClosedBeforeReady:
      "La fenêtre séparée s’est fermée avant de prendre le contrôle.",
    layoutDataMissing:
      "La disposition était indiquée comme prête, mais aucune donnée de disposition n’a été renvoyée.",
    namedLayoutMissing:
      "Cette disposition nommée n’existe plus. Actualisez la liste et réessayez.",
    closeCurrent: "Fermer ce terminal",
    closeOthers: "Fermer les autres terminaux du panneau ({{count}})",
    closeAllInPane: "Fermer tous les terminaux du panneau ({{count}})",
    splitTooSmall:
      "Le panneau doit avoir au moins {{size}} px de {{axis}} pour être divisé à nouveau.",
    width: "largeur",
    height: "hauteur",
    confirmClose:
      "Terminer cette session de terminal et ses processus enfants ?",
    confirmCloseMany:
      "Terminer ces {{count}} sessions de terminal et leurs processus enfants ?",
    closePending:
      "{{count}} sessions de terminal sont en cours de démarrage et ne peuvent pas encore être fermées.",
    closeFailedMany:
      "Impossible de fermer {{count}} sessions de terminal. Consultez les terminaux concernés pour plus de détails.",
    status: {
      running: "En cours",
      exited: "Terminée",
      terminated: "Arrêtée",
      failed: "Échec",
    },
  },
  cliStatus: {
    available: "Installée",
    availableTitle: "Installée et prête à démarrer",
    missing: "Introuvable",
    missingTitle: "Introuvable. Ouvrez les paramètres pour l’installer",
    unknown: "Échec de la vérification",
    unknownTitle:
      "Échec de la vérification. Actualisez pour réessayer ; le démarrage et l’installation sont désactivés",
  },
  time: {
    neverStarted: "Jamais lancée",
    unknown: "Heure inconnue",
  },
  projects: {
    title: "Projets",
    searchPlaceholder: "Rechercher un projet par nom",
    sortRecent: "Récemment utilisés",
    sortName: "Nom",
    refreshCli: "Détecter à nouveau les CLI",
    addDirectory: "Ajouter un répertoire",
    chooseDirectory: "Choisir le répertoire du projet",
    namePlaceholder: "Nom",
    pathPlaceholder: "Chemin complet ou sélectionnez Parcourir",
    addFailed: "Impossible d’ajouter le répertoire : {{error}}",
    launchFailed: "Échec du démarrage : {{error}}",
    openPathFailed: "Impossible d’ouvrir le répertoire : {{error}}",
    empty:
      "Aucun répertoire correspondant. Choisissez Ajouter un répertoire pour en créer un.",
  },
  emptyProjects: {
    title: "Choisissez un projet pour commencer",
    description:
      "Ajoutez un projet local pour lancer et basculer entre les sessions CLI dans son espace de travail.",
    addProject: "Ajouter un projet",
  },
  projectDialog: {
    addTitle: "Ajouter un projet",
    editTitle: "Modifier le projet",
    name: "Nom du projet",
    directory: "Répertoire du projet",
    chooseDirectory: "Choisir un répertoire",
    chooseFailed: "Impossible de choisir le répertoire du projet : {{error}}",
    note: "Note",
    notePlaceholder: "Note facultative sur ce projet",
    loading: "Chargement des détails du projet…",
    saving: "Enregistrement…",
    saveFailed: "Impossible d’enregistrer le projet : {{error}}",
  },
  projectDetail: {
    noDirectory: "Aucun répertoire sélectionné.",
    context: "Contexte du projet",
    cliLaunchers: "Démarrer une CLI",
    showContextPanel: "Afficher le contexte du projet",
    hideContextPanel: "Masquer le contexte du projet",
    openDirectory: "Ouvrir le répertoire",
    openPathFailed: "Impossible d’ouvrir le répertoire : {{error}}",
    launchTool: "Démarrer {{tool}} dans le terminal intégré",
    sessions: "Historique des sessions",
    searchSessions: "Rechercher des sessions",
    searchPlaceholder: "Rechercher des titres, résumés ou alias de session",
    clearSearch: "Effacer la recherche",
    searchIncomplete:
      "Certaines sources de sessions n’ont pas pu être entièrement recherchées : {{tools}}",
    searchFailed: "Échec de la recherche de sessions : {{error}}",
    noSearchResults: "Aucune session correspondante.",
    resumeEmbedded: "Reprendre",
    refreshSessions: "Actualiser les sessions",
    sessionsFailed: "Impossible de lire les sessions : {{error}}",
    reading: "Chargement…",
    aliasRequired: "L’alias de session ne peut pas être vide",
    sessionAlias: "Alias de session",
    originalTitle: "Titre d’origine : {{title}}",
    customTitle: "Titre personnalisé",
    saveAlias: "Enregistrer l’alias de session",
    cancelRename: "Annuler le renommage",
    renameSession: "Renommer la session",
    restoreOriginal: "Restaurer le titre d’origine",
    restore: "Reprendre",
    loadMoreFailed: "Impossible de charger la suite : {{error}}",
    noSessions: "Aucun historique de session.",
  },
  settings: {
    title: "Paramètres",
    refresh: "Détecter à nouveau",
    cliStatus: "État des CLI",
    detectFailed: "Échec de la détection : {{error}}",
    updateAvailable: "Mise à jour disponible",
    taskActiveTitle:
      "Une tâche d’installation ou de mise à jour est déjà en cours",
    preparing: "Préparation…",
    install: "Installer",
    update: "Mettre à jour",
    grokInstallEffectsHeading: "Le programme d’installation officiel va :",
    grokInstallEffectPath:
      "Installer dans .grok\\bin du profil de l’utilisateur actuel, ou dans GROK_BIN_DIR si cette variable est définie.",
    grokInstallEffectChannel:
      "Launchpad fixe le canal stable afin que les paramètres d’environnement hérités ne sélectionnent pas un canal de préversion ou d’entreprise.",
    grokInstallEffectFiles:
      "Télécharger et installer grok.exe et agent.exe en remplaçant les fichiers existants ; créer ou mettre à jour le marqueur d’installation CLI dans .grok\\config.toml du profil utilisateur actuel et générer les complétions PowerShell.",
    grokInstallEffectPathEnv:
      "Ajouter le répertoire d’installation au PATH de l’utilisateur actuel s’il n’y figure pas déjà.",
    grokInstallEffectNetwork:
      "Récupérer les informations de version et les binaires depuis x.ai, avec Google Cloud Storage en solution de repli. Si GROK_DEPLOYMENT_KEY est présent dans l’environnement, récupérer aussi les paramètres de déploiement et écrire les fichiers de configuration gérés.",
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
      "Actualisez d’abord les informations de version pour vérifier la source d’installation de Grok Build.",
    installing: "Installation…",
    updating: "Mise à jour…",
    refreshingVersion: "Actualisation de la version…",
    refreshingVersionTitle: "Lecture de la version mise à jour de la CLI",
    refreshingVersionDescription:
      "La tâche est terminée. Vérification de l’état de la version mise à jour.",
    confirmInstall: "Confirmer l’installation",
    confirmUpdate: "Confirmer la mise à jour",
    creatingTask: "Création de la tâche…",
    confirmRun: "Exécuter",
    source: "Source : {{source}}",
    commandNotice:
      "Cette commande sera exécutée sur votre ordinateur. Après confirmation, suivez ses journaux en direct dans Tâches.",
    executeFailed: "Échec de l’exécution : {{error}}",
    path: "Chemin : {{path}}",
    current: "Actuelle : ",
    latest: "Dernière : ",
    unavailableWithError: "Indisponible ({{error}})",
    unknownRefresh: "Inconnu ; relancez la détection en haut à droite",
    hermesRefreshPrompt:
      "Actualisez manuellement pour vérifier la branche main",
    hermesUpToDate: "À jour avec main",
    hermesUpdateBehind: "{{count}} commits de retard sur main",
    hermesUpdateBehindUnknown:
      "Mises à jour sur main (nombre de commits indisponible)",
    hermesUpdateStatus: "État de la mise à jour : ",
    hermesInstallEffectsHeading: "Le programme d’installation officiel va :",
    hermesInstallEffectRuntime:
      "Installer Hermes CLI, ses environnements Python/Node gérés et les dépendances pour l’utilisateur actuel.",
    hermesInstallEffectData:
      "Préparer le code source, la configuration et les données utilisateur dans %LOCALAPPDATA%\\hermes ; le programme d’installation officiel gère les données existantes.",
    hermesInstallEffectPath:
      "Ajouter %LOCALAPPDATA%\\hermes\\bin au PATH de l’utilisateur actuel s’il n’est pas déjà configuré.",
    hermesInstallEffectNetwork:
      "Télécharger le script depuis l’adresse officielle de l’installeur Hermes, puis récupérer le code source, les environnements et les dépendances.",
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
    checking: "Vérification…",
    cachedSuffix: " (en cache)",
    refreshFailedSuffix: " ; échec de l’actualisation : {{error}}",
    unavailable: "Indisponible",
    managementComingSoon:
      "Les actions d’installation et de mise à jour seront ajoutées ultérieurement.",
    prepareFailed: "Impossible de préparer l’action : {{error}}",
    taskRunning:
      "Une tâche est en cours pour cet outil. Ouvrez Tâches dans la barre latérale pour la suivre.",
    launchMethod: "Méthode de lancement",
    launchHintMac:
      "Le mode automatique utilise toujours Terminal.app. Les terminaux tiers ne sont utilisés que s’ils sont explicitement sélectionnés.",
    launchHintWindows:
      "Privilégie un profil Windows Terminal, puis utilise un shell autonome s’il n’est pas disponible.",
    launchHintLinux:
      "Le mode automatique délègue d’abord au terminal par défaut du bureau ; vous pouvez aussi choisir manuellement un terminal détecté.",
    launchHintOther:
      "Détecter les méthodes de lancement de terminal disponibles pour la plateforme actuelle.",
    refreshTerminal: "Détecter à nouveau l’environnement du terminal",
    detectingTerminal: "Détection de l’environnement du terminal…",
    launchLoadFailed:
      "Impossible de charger les méthodes de lancement : {{error}}",
    autoSelect: "Automatique",
    autoDescriptionMac:
      "Toujours utiliser Terminal.app. L’installation d’un terminal tiers ne modifiera pas le comportement par défaut.",
    autoDescriptionWindows:
      "Utiliser d’abord le profil Windows Terminal par défaut, puis PowerShell 7, Windows PowerShell et CMD en solution de repli.",
    autoDescriptionLinux:
      "Déléguer d’abord au terminal par défaut du bureau via xdg-terminal-exec, puis essayer les terminaux détectés dans l’ordre.",
    recommended: "Recommandé",
    unknownVersion: "Version inconnue",
    noProfiles:
      "Aucun profil sélectionnable n’a été trouvé. Le mode automatique essaiera tout de même le profil par défaut.",
    defaultProfile: "Profil par défaut",
    standaloneConsole: "Consoles autonomes",
    standaloneDescription: "Ne pas utiliser de profil Windows Terminal",
    fallbackPriority: "Priorité de repli {{priority}}",
    standaloneWindow: "Fenêtre autonome",
    macTerminals: "Terminaux macOS",
    linuxTerminals: "Terminaux Linux",
    detectedCount_one: "{{count}} détecté",
    detectedCount_other: "{{count}} détectés",
    noTerminals:
      "Aucun terminal disponible n’a été détecté. Le lancement automatique est actuellement indisponible.",
    systemDefault: "Valeur par défaut du système",
    native: "Natif",
    unavailableSavedTarget:
      "La cible de lancement enregistrée {{target}} n’est pas disponible sur cette plateforme. Les lancements utiliseront le terminal recommandé. Sélectionnez un terminal disponible pour mettre à jour ce paramètre.",
    saveLaunchFailed:
      "Impossible d’enregistrer la méthode de lancement : {{error}}",
    closeBehavior: "Comportement à la fermeture de la fenêtre",
    closeDescriptionMac:
      "Par défaut, la fermeture laisse l’application en arrière-plan. Utilisez l’icône du Dock ou l’élément de la barre de menus pour la réafficher.",
    closeDescriptionOther:
      "Par défaut, la fermeture laisse l’application dans la zone de notification. Double-cliquez sur son icône pour la réafficher.",
    closeMinimize: "Garder l’application en arrière-plan",
    closeQuit: "Quitter l’application",
    saveFailed: "Échec de l’enregistrement : {{error}}",
    configBackup: "Sauvegarde de la configuration",
    configBackupDescription:
      "Exporter ou importer les répertoires et notes des projets. L’importation fusionne par chemin sans dupliquer les répertoires.",
    exportFile: "Exporter vers un fichier",
    importFile: "Importer depuis un fichier",
    exported: "Exporté.",
    exportFailed: "Échec de l’exportation : {{error}}",
    importSuccess: "Importation réussie.",
    importFailed: "Échec de l’importation : {{error}}",
    diagnostics: "Diagnostics",
    exportDiagnostics: "Exporter le rapport de diagnostic",
    recentLaunch: "Lancements récents",
    launchHistoryRetention: "Conserver l’historique",
    launchHistoryRetentionCount: "{{count}} derniers lancements",
    launchHistoryProject: "Projet : ",
    launchHistoryPath: "Chemin : ",
    launchHistoryTime: "Heure : ",
    launchHistorySessionId: "ID de session : ",
    clearHistory: "Effacer l’historique",
    resumeSession: "Reprendre la session",
    newSession: "Nouvelle session",
    success: "Réussi",
    failed: "Échec",
    cache: "Cache",
    entries: "Entrées : {{count}}",
    size: "Taille : {{size}}",
    newestWrite: "Dernière écriture : {{time}}",
    clearCache: "Vider le cache",
    recovery: "Récupération des données",
    recoveryDescription:
      "Des points de restauration automatiques sont créés avant les importations et restaurations. Les points manuels enregistrent toutes les données actuelles de l’application.",
    createRecovery: "Créer un point de restauration",
    readRecoveryFailed:
      "Impossible de lire les points de restauration : {{error}}",
    restore: "Restaurer",
    confirmRestore: "Restaurer les données ?",
    restoreDescription:
      "Restaurer les données à leur état du {{time}}. L’état actuel sera d’abord sauvegardé automatiquement.",
    confirmRestoreAction: "Confirmer la restauration",
    restoreFailed: "Échec de la restauration : {{error}}",
    backupReason: {
      manual: "Point de restauration manuel",
      pre_import: "Sauvegarde automatique avant importation",
      pre_restore: "Sauvegarde de protection avant restauration",
      pre_migration: "Sauvegarde automatique avant mise à niveau",
    },
    preservation: {
      exact: "Conservé intégralement",
      command_continuation: "Continuation de la commande",
      appearance_only: "Apparence uniquement",
    },
    shell: { custom: "Shell personnalisé" },
    terminalDescription: {
      command_document:
        "Ouvrir via LaunchServices un fichier .command à usage unique qui s’autodétruit",
      apple_script:
        "Créer une fenêtre Ghostty native et saisir la commande via AppleScript",
      direct_arguments:
        "Transmettre des arguments structurés à la CLI officielle incluse dans l’application",
      kittySuffix: " ; garder la fenêtre ouverte après la fin de la commande",
      xdg_terminal_exec:
        "Déléguer le lancement au terminal par défaut du bureau (xdg-terminal-exec)",
      shell_wrapped:
        "Exécuter la commande dans une nouvelle fenêtre avec l’option -e",
    },
  },
  about: {
    title: "À propos",
    version: "Version {{version}}",
    description:
      "Un espace de travail de bureau centré sur les projets, compatible avec cinq CLI d’IA, un terminal intégré à plusieurs panneaux, l’historique et la restauration des sessions, ainsi que des dispositions réutilisables.",
    supportedCli: "CLI prises en charge",
    repository: "Dépôt du projet",
    repositoryDescription:
      "Consultez le code source et les actualités de CLI Launchpad.",
    openRepository: "Voir sur GitHub",
    openRepositoryError:
      "Impossible d’ouvrir le dépôt GitHub dans le navigateur par défaut.",
    licenses: "Licences open source",
    licenseIntro:
      "CLI Launchpad et ses icônes de marque intégrées utilisent la licence MIT. Les polices intégrées restent soumises à leurs licences SIL Open Font License 1.1 respectives.",
  },
  executions: {
    title: "Tâches",
    description:
      "Consultez les sorties en direct et l’historique des installations et mises à jour.",
    operationInstall: "installation",
    operationUpdate: "mise à jour",
    taskToastTitle: "{{tool}} {{operation}}",
    taskSucceededToast: "{{title}} : réussite",
    taskFailedToast: "{{title}} : échec",
    taskStoppedToast: "{{title}} : arrêtée",
    refresh: "Actualiser les tâches",
    clearHistory: "Effacer l’historique",
    clearAllTitle: "Effacer toutes les tâches terminées ?",
    clearAllDescription:
      "{{count}} tâches et leurs journaux seront définitivement supprimés.",
    clearing: "Effacement…",
    confirmClear: "Effacer les tâches",
    readFailed: "Impossible de lire les tâches : {{error}}",
    operationFailed: "Échec de l’opération : {{error}}",
    listLabel: "Liste des tâches",
    readingTasks: "Chargement des tâches…",
    emptyTitle: "Aucune tâche pour le moment",
    emptyDescription:
      "Installez ou mettez à jour une CLI depuis les paramètres pour afficher la tâche ici.",
    install: "Installer",
    update: "Mettre à jour",
    selectTask: "Sélectionnez une tâche pour consulter ses journaux.",
    source: "Source : {{source}}",
    cancelling: "Arrêt en cours",
    cancelTask: "Arrêter la tâche",
    clearRecord: "Supprimer l’entrée",
    cancelTitle: "Arrêter cette tâche ?",
    cancelDescription:
      "L’arborescence complète des processus sera terminée. L’interruption d’une mise à jour peut nécessiter la réinstallation de la CLI.",
    requesting: "Demande en cours…",
    confirmCancel: "Confirmer l’arrêt",
    deleteTitle: "Supprimer cet enregistrement de tâche ?",
    deleteDescription:
      "Les journaux historiques associés seront également supprimés définitivement.",
    deleting: "Suppression…",
    confirmDelete: "Confirmer la suppression",
    startedAt: "Démarrée à {{time}}",
    exitCode: "Code de sortie {{code}}",
    followOutput: "Suivre la dernière sortie",
    readingLogs: "Chargement des journaux…",
    noOutput: "(Aucune sortie pour le moment)",
    truncated:
      "La limite du journal de 1 MiB est atteinte. Les sorties suivantes n’ont pas été enregistrées.",
    status: {
      preparing: "Préparation",
      running: "En cours",
      cancelling: "Arrêt en cours",
      succeeded: "Réussie",
      failed: "Échec",
      cancelled: "Annulée",
      timed_out: "Délai dépassé",
      interrupted: "Interrompue inopinément",
    },
    stream: {
      stdout: "Sortie",
      stderr: "Erreur",
      system: "Système",
    },
  },
  workspaceFiles: {
    rightPanelTabs: "Onglets du panneau droit",
    files: "Fichiers",
    git: "Git",
    gitLater: "La gestion Git sera disponible dans une étape ultérieure.",
    projectRoot: "Racine du projet",
    refresh: "Actualiser",
    showHidden: "Afficher les fichiers cachés",
    emptyDirectory: "Ce dossier est vide",
    symlinkDisabled: "Les liens symboliques ne peuvent pas encore être ouverts",
    ignored: "Ignoré",
    closeFile: "Fermer le fichier",
    closeFileNamed: "Fermer {{name}}",
    fileMenu: "Menu de la fenêtre du fichier",
    closeOthers: "Fermer les autres fichiers du panneau ({{count}})",
    closeAllInPane: "Fermer tous les fichiers du panneau ({{count}})",
    splitAndMoveRight: "Scinder à droite et déplacer ce fichier",
    splitAndMoveDown: "Scinder en bas et déplacer ce fichier",
    discardChanges:
      "Ce fichier contient des modifications non enregistrées. Le fermer et les abandonner ?",
    save: "Enregistrer",
    reload: "Recharger",
    directoryLimitReached: "Trop d’éléments. Les 5 000 premiers sont affichés.",
    loadingFile: "Chargement du fichier…",
    fileCannotOpen: "Ce fichier ne peut pas être ouvert ici",
    imagePreview: "Aperçu de l’image",
    unsupported: {
      binary:
        "L’éditeur de texte ne prend pas en charge les fichiers binaires.",
      tooLarge: "Le fichier dépasse la limite de taille d’aperçu.",
      invalidImage:
        "Les données de l’image ne correspondent pas à son extension.",
      unsupportedImage: "Ce format d’image n’est pas pris en charge.",
    },
  },
} satisfies LocaleShape<typeof en>;
