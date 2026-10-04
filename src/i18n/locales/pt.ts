import type { en } from "./en";

type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const pt = {
  common: {
    back: "Voltar",
    browse: "Procurar",
    cancel: "Cancelar",
    save: "Salvar",
    copy: "Copiar",
    more: "Mais",
    loading: "Carregando…",
    none: "(Nenhum)",
  },
  sidebar: {
    projects: "Projetos",
    collapse: "Recolher barra lateral",
    expand: "Expandir barra lateral",
    addProject: "Adicionar projeto",
    searchProjects: "Pesquisar projetos por nome",
    projectActions: "Ações para {{name}}",
    renameProject: "Renomear projeto",
    pinProject: "Fixar projeto",
    unpinProject: "Desafixar projeto",
    openProjectFolder: "Abrir pasta do projeto",
    removeProject: "Remover projeto",
    confirmRemoveProject:
      "Remover o projeto “{{name}}”? Os arquivos no disco não serão excluídos.",
    pinProjectFailed: "Falha ao fixar o projeto: {{error}}",
    reorderProjectsFailed: "Falha ao reordenar os projetos: {{error}}",
    openProjectFolderFailed:
      "Não foi possível abrir a pasta do projeto: {{error}}",
    removeProjectFailed: "Não foi possível remover o projeto: {{error}}",
    noProjects: "Ainda não há projetos. Adicione um para começar.",
    noMatchingProjects: "Nenhum projeto correspondente.",
    executions: "Tarefas",
    settings: "Configurações",
    about: "Sobre",
    activeTasks_one: "{{count}} tarefa ativa",
    activeTasks_other: "{{count}} tarefas ativas",
    managedCliSessions_one: "{{tool}}, {{count}} sessão gerenciada",
    managedCliSessions_other: "{{tool}}, {{count}} sessões gerenciadas",
  },
  theme: {
    current: "Tema: {{mode}}",
    select: "Escolher tema",
    light: "Claro",
    dark: "Escuro",
    system: "Sistema",
  },
  language: {
    current: "Idioma: {{language}}",
    select: "Escolher idioma",
    zh: "简体中文",
    en: "English",
  },
  appExit: {
    title: "Sair do CLI Launchpad?",
    description:
      "Ao sair, as sessões de terminal incorporado que estiverem em execução ({{count}}) serão encerradas junto com seus processos filhos.",
    confirm: "Encerrar sessões e sair",
    terminating: "Encerrando sessões…",
  },
  windowChrome: {
    titlebar: "Barra de título da janela do aplicativo",
    minimize: "Minimizar",
    maximize: "Maximizar",
    restore: "Restaurar",
    close: "Fechar janela",
  },
  pty: {
    panelLabel: "Terminal incorporado",
    paneLabel: "Painel do terminal",
    paneNumber: "Painel {{number}}",
    paneSessions: "Sessões de terminal neste painel",
    layoutLoading: "Restaurando espaço de trabalho…",
    layoutNeedsReset:
      "Não foi possível ler o layout do espaço de trabalho ({{reason}}). Os dados originais foram preservados e o salvamento automático está pausado.",
    layoutLoadFailed:
      "Não foi possível ler o layout do espaço de trabalho: {{error}}. Esta execução não substituirá os dados originais.",
    retryLayoutRead: "Tentar ler novamente",
    resetLayout: "Redefinir layout do espaço de trabalho",
    layoutResetPending: "Redefinindo…",
    confirmLayoutReset:
      "Não foi possível ler o layout do espaço de trabalho. A redefinição substituirá o layout danificado por um espaço de trabalho vazio. Continuar?",
    layoutResetFailed:
      "Não foi possível redefinir o espaço de trabalho: {{error}}",
    layoutSaveFailed:
      "Não foi possível salvar o espaço de trabalho automaticamente: {{error}}. Os terminais continuam disponíveis.",
    layouts: "Layouts",
    namedLayouts: "Layouts nomeados",
    layoutNamePlaceholder: "Nome do layout",
    saveLayout: "Salvar layout atual",
    applyLayout: "Aplicar",
    layoutApplied: "Layout aplicado; as sessões em execução foram preservadas",
    renameLayout: "Renomear layout",
    overwriteLayout: "Substituir pelo layout atual",
    deleteLayout: "Excluir layout",
    layoutSaved: "Layout salvo",
    layoutRenamed: "Layout renomeado",
    layoutOverwritten: "Layout atualizado",
    layoutDeleted: "Layout excluído",
    layoutActionFailed: "Falha na ação do layout: {{error}}",
    layoutChangedDuringApply:
      "O espaço de trabalho mudou durante a aplicação do layout. Tente novamente.",
    layoutPresetMissing:
      "Este layout nomeado não existe mais. Atualize a lista e tente novamente.",
    layoutsLoading: "Carregando layouts…",
    noNamedLayouts: "Ainda não há layouts salvos.",
    confirmOverwriteLayout:
      "Substituir “{{name}}” pelos painéis e sessões atuais?",
    confirmDeleteLayout: "Excluir “{{name}}”?",
    closeLayoutManager: "Fechar gerenciador de layouts",
    confirmLayoutAction: "Confirmar",
    projectUnavailable:
      "Não foi possível encontrar este projeto, então o terminal não pode ser iniciado.",
    restoredEnded:
      "Esta sessão terminou. A CLI não será iniciada automaticamente; restaure-a mais tarde pelo histórico de sessões.",
    restoredMissingProject:
      "O projeto vinculado a esta sessão não existe mais.",
    restoredProjectMismatch:
      "O caminho ou a identidade do projeto mudou, então não é possível confirmar que esta sessão pertence a ele.",
    restoredMissingSession: "O registro da sessão não existe mais.",
    restoredSessionMismatch:
      "A sessão não está mais vinculada a este projeto ou CLI.",
    previousSessions: "{{count}} itens anteriores",
    nextSessions: "{{count}} itens seguintes",
    previousSessionsHeading: "Itens anteriores",
    nextSessionsHeading: "Itens seguintes",
    emptyPane: "Painel vazio",
    empty:
      "Restaure uma sessão à direita ou abra um arquivo ou inicie uma CLI neste painel.",
    starting: "Criando sessão de terminal…",
    terminalNotReady:
      "O terminal ainda não está pronto. Tente novamente em instantes.",
    close: "Fechar sessão de terminal",
    closeNamed: "Fechar {{name}}",
    sessionMenu: "Menu da sessão de terminal",
    closeEmptyPane: "Fechar painel vazio",
    splitRight: "Dividir à direita",
    splitDown: "Dividir abaixo",
    splitAndMoveRight: "Dividir à direita e mover este terminal",
    splitAndMoveDown: "Dividir abaixo e mover este terminal",
    moveToPane: "Mover para o painel",
    dropIntoPane: "Solte para mover para {{pane}}",
    openSeparateWindow: "Abrir em janela separada",
    returnToWorkspace: "Voltar ao espaço de trabalho",
    returningToWorkspace: "Movendo de volta ao espaço de trabalho…",
    returnFailed: "Não foi possível voltar ao espaço de trabalho: {{error}}",
    returnTimedOut: "O espaço de trabalho principal não respondeu a tempo.",
    detachedDefaultTitle: "Terminal da CLI",
    detachedMoveUnavailable:
      "Este terminal não pode ser movido para uma janela separada.",
    detachedMoveNotRunning:
      "Somente um terminal em execução pode ser movido para uma janela separada.",
    detachedStartTimedOut:
      "O tempo para iniciar a janela de terminal separada esgotou.",
    detachedCreateFailed:
      "Não foi possível criar a janela de terminal separada.",
    detachedStartFailed:
      "Não foi possível iniciar a janela de terminal separada.",
    detachedStateChanged: "O estado da janela separada mudou. Tente novamente.",
    detachedSessionMissing:
      "Esta sessão de terminal não foi encontrada no espaço de trabalho principal.",
    workspaceRestoring:
      "O espaço de trabalho principal ainda está restaurando os terminais. Tente novamente em instantes.",
    detachedExitedBeforeReady:
      "O PTY foi encerrado antes de a janela separada assumir o controle.",
    detachedClosedBeforeReady:
      "A janela separada foi fechada antes de assumir o controle.",
    layoutDataMissing:
      "O layout foi marcado como pronto, mas nenhum dado de layout foi retornado.",
    namedLayoutMissing:
      "Este layout nomeado não existe mais. Atualize a lista e tente novamente.",
    closeCurrent: "Fechar este terminal",
    closeOthers: "Fechar outros conteúdos no painel ({{count}})",
    closeAllInPane: "Fechar todo o conteúdo no painel ({{count}})",
    splitTooSmall:
      "O painel precisa de pelo menos {{size}} px de {{axis}} para ser dividido novamente.",
    width: "largura",
    height: "altura",
    confirmClose: "Encerrar esta sessão de terminal e seus processos filhos?",
    confirmCloseMany:
      "Encerrar estas {{count}} sessões de terminal e seus processos filhos?",
    closePending:
      "{{count}} sessões de terminal ainda estão iniciando e não podem ser fechadas agora.",
    closeFailedMany:
      "Não foi possível fechar {{count}} sessões de terminal. Consulte os terminais afetados para ver os detalhes.",
    status: {
      running: "Em execução",
      exited: "Encerrado",
      terminated: "Finalizado",
      failed: "Falhou",
    },
  },
  cliStatus: {
    available: "Instalada",
    availableTitle: "Instalada e pronta para iniciar",
    missing: "Não encontrada",
    missingTitle: "Não encontrada. Abra Configurações para instalar",
    unknown: "Falha na verificação",
    unknownTitle:
      "Falha na verificação. Atualize para tentar novamente; a inicialização e a instalação estão desativadas",
  },
  time: {
    neverStarted: "Nunca iniciada",
    unknown: "Horário desconhecido",
  },
  projects: {
    title: "Projetos",
    searchPlaceholder: "Pesquisar projetos por nome",
    sortRecent: "Usados recentemente",
    sortName: "Nome",
    refreshCli: "Detectar CLIs novamente",
    addDirectory: "Adicionar diretório",
    chooseDirectory: "Escolher diretório do projeto",
    namePlaceholder: "Nome",
    pathPlaceholder: "Caminho completo ou escolha Procurar",
    addFailed: "Não foi possível adicionar o diretório: {{error}}",
    launchFailed: "Falha ao iniciar: {{error}}",
    openPathFailed: "Não foi possível abrir o diretório: {{error}}",
    empty:
      "Nenhum diretório correspondente. Escolha Adicionar diretório para criar um.",
  },
  emptyProjects: {
    title: "Escolha um projeto para começar",
    description:
      "Adicione um projeto local para iniciar e alternar sessões de CLI no espaço de trabalho dele.",
    addProject: "Adicionar projeto",
  },
  projectDialog: {
    addTitle: "Adicionar projeto",
    editTitle: "Editar projeto",
    name: "Nome do projeto",
    directory: "Diretório do projeto",
    chooseDirectory: "Escolher diretório",
    chooseFailed: "Não foi possível escolher o diretório do projeto: {{error}}",
    note: "Observação",
    notePlaceholder: "Observação opcional sobre este projeto",
    loading: "Carregando detalhes do projeto…",
    saving: "Salvando…",
    saveFailed: "Não foi possível salvar o projeto: {{error}}",
  },
  projectDetail: {
    noDirectory: "Nenhum diretório selecionado.",
    context: "Contexto do projeto",
    cliLaunchers: "Iniciar uma CLI",
    showContextPanel: "Mostrar contexto do projeto",
    hideContextPanel: "Ocultar contexto do projeto",
    openDirectory: "Abrir diretório",
    openPathFailed: "Não foi possível abrir o diretório: {{error}}",
    launchTool: "Iniciar {{tool}} no terminal incorporado",
    sessions: "Histórico de sessões",
    searchSessions: "Pesquisar sessões",
    searchPlaceholder: "Pesquisar títulos, resumos ou apelidos de sessões",
    clearSearch: "Limpar pesquisa",
    searchIncomplete:
      "Não foi possível pesquisar completamente algumas fontes de sessão: {{tools}}",
    searchFailed: "Falha ao pesquisar sessões: {{error}}",
    noSearchResults: "Nenhuma sessão correspondente.",
    resumeEmbedded: "Retomar",
    refreshSessions: "Atualizar sessões",
    sessionsFailed: "Não foi possível ler as sessões: {{error}}",
    reading: "Carregando…",
    aliasRequired: "O apelido da sessão não pode ficar vazio",
    sessionAlias: "Apelido da sessão",
    originalTitle: "Título original: {{title}}",
    customTitle: "Título personalizado",
    saveAlias: "Salvar apelido da sessão",
    cancelRename: "Cancelar renomeação",
    renameSession: "Renomear sessão",
    restoreOriginal: "Restaurar título original",
    restore: "Retomar",
    loadMoreFailed: "Não foi possível carregar mais: {{error}}",
    noSessions: "Nenhum histórico de sessões.",
  },
  settings: {
    title: "Configurações",
    refresh: "Detectar novamente",
    cliStatus: "Status das CLIs",
    detectFailed: "Falha na detecção: {{error}}",
    updateAvailable: "Atualização disponível",
    taskActiveTitle:
      "Já existe uma tarefa de instalação ou atualização em execução",
    preparing: "Preparando…",
    install: "Instalar",
    update: "Atualizar",
    grokInstallEffectsHeading: "O instalador oficial irá:",
    grokInstallEffectPath:
      "Instalar em .grok\\bin no perfil do usuário atual ou em GROK_BIN_DIR, se estiver definido.",
    grokInstallEffectChannel:
      "O Launchpad fixa o canal estável para que as configurações de ambiente herdadas não selecionem um canal de pré-lançamento ou corporativo.",
    grokInstallEffectFiles:
      "Baixar e instalar grok.exe e agent.exe, substituindo arquivos existentes; criar ou atualizar o marcador do instalador da CLI em .grok\\config.toml no perfil do usuário atual e gerar conclusões do PowerShell.",
    grokInstallEffectPathEnv:
      "Adicionar o diretório de instalação ao PATH do usuário atual se ele ainda não estiver presente.",
    grokInstallEffectNetwork:
      "Buscar informações de versão e binários em x.ai, com o Google Cloud Storage como alternativa. Se GROK_DEPLOYMENT_KEY estiver no ambiente, também buscar configurações de implantação e gravar arquivos de configuração gerenciados.",
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
      "Atualize as informações de versão primeiro para verificar a origem da instalação do Grok Build.",
    installing: "Instalando…",
    updating: "Atualizando…",
    refreshingVersion: "Atualizando versão…",
    refreshingVersionTitle: "Lendo a versão atualizada da CLI",
    refreshingVersionDescription:
      "A tarefa foi concluída. Confirmando o estado da versão atualizada.",
    confirmInstall: "Confirmar instalação",
    confirmUpdate: "Confirmar atualização",
    creatingTask: "Criando tarefa…",
    confirmRun: "Executar",
    source: "Origem: {{source}}",
    commandNotice:
      "Este comando será executado no seu computador. Após confirmar, acompanhe os registros ao vivo em Tarefas.",
    executeFailed: "Falha na execução: {{error}}",
    path: "Caminho: {{path}}",
    current: "Atual: ",
    latest: "Mais recente: ",
    unavailableWithError: "Indisponível ({{error}})",
    unknownRefresh: "Desconhecido; detecte novamente no canto superior direito",
    hermesRefreshPrompt: "Atualize manualmente para verificar a branch main",
    hermesUpToDate: "Atualizado com a main",
    hermesUpdateBehind: "{{count}} commits atrás da main",
    hermesUpdateBehindUnknown:
      "Há atualizações na main (quantidade de commits indisponível)",
    hermesUpdateStatus: "Status da atualização: ",
    hermesInstallEffectsHeading: "O instalador oficial irá:",
    hermesInstallEffectRuntime:
      "Instalar a CLI Hermes, os ambientes Python/Node gerenciados e as dependências para o usuário atual.",
    hermesInstallEffectData:
      "Preparar o código-fonte, as configurações e os dados do usuário em %LOCALAPPDATA%\\hermes; o instalador oficial gerencia os dados existentes.",
    hermesInstallEffectPath:
      "Adicionar %LOCALAPPDATA%\\hermes\\bin ao PATH do usuário atual se ainda não estiver configurado.",
    hermesInstallEffectNetwork:
      "Baixar o script do endereço oficial do instalador Hermes e buscar código-fonte, ambientes e dependências.",
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
    checking: "Verificando…",
    cachedSuffix: " (em cache)",
    refreshFailedSuffix: "; falha ao atualizar: {{error}}",
    unavailable: "Indisponível",
    managementComingSoon:
      "As ações de instalação e atualização serão adicionadas em uma etapa futura.",
    prepareFailed: "Não foi possível preparar a ação: {{error}}",
    taskRunning:
      "Há uma tarefa em execução para esta ferramenta. Abra Tarefas na barra lateral para acompanhá-la.",
    launchMethod: "Método de inicialização",
    launchHintMac:
      "O modo automático sempre usa o Terminal.app. Terminais de terceiros só são usados quando selecionados explicitamente.",
    launchHintWindows:
      "Dá preferência a um perfil do Windows Terminal e usa um shell independente como alternativa quando ele não está disponível.",
    launchHintLinux:
      "O modo automático delega primeiro ao terminal padrão do ambiente gráfico; você também pode escolher manualmente um terminal detectado.",
    launchHintOther:
      "Detectar métodos de inicialização de terminal disponíveis para a plataforma atual.",
    refreshTerminal: "Detectar ambiente do terminal novamente",
    detectingTerminal: "Detectando ambiente do terminal…",
    launchLoadFailed:
      "Não foi possível carregar os métodos de inicialização: {{error}}",
    autoSelect: "Automático",
    autoDescriptionMac:
      "Sempre usar o Terminal.app. A instalação de um terminal de terceiros não altera o padrão.",
    autoDescriptionWindows:
      "Usar primeiro o perfil padrão do Windows Terminal e, em seguida, PowerShell 7, Windows PowerShell e CMD como alternativas.",
    autoDescriptionLinux:
      "Delegar primeiro ao terminal padrão do ambiente gráfico por meio do xdg-terminal-exec e, em seguida, tentar os terminais detectados em ordem.",
    recommended: "Recomendado",
    unknownVersion: "Versão desconhecida",
    noProfiles:
      "Nenhum perfil selecionável foi encontrado. O modo automático ainda tentará usar o perfil padrão.",
    defaultProfile: "Perfil padrão",
    standaloneConsole: "Consoles independentes",
    standaloneDescription: "Não usar um perfil do Windows Terminal",
    fallbackPriority: "Prioridade alternativa {{priority}}",
    standaloneWindow: "Janela independente",
    macTerminals: "Terminais do macOS",
    linuxTerminals: "Terminais do Linux",
    detectedCount_one: "{{count}} detectado",
    detectedCount_other: "{{count}} detectados",
    noTerminals:
      "Nenhum terminal disponível foi detectado. A inicialização automática está indisponível no momento.",
    systemDefault: "Padrão do sistema",
    native: "Nativo",
    unavailableSavedTarget:
      "O destino de inicialização salvo {{target}} não está disponível nesta plataforma. As inicializações usarão o terminal recomendado. Selecione um terminal disponível para atualizar esta configuração.",
    saveLaunchFailed:
      "Não foi possível salvar o método de inicialização: {{error}}",
    closeBehavior: "Comportamento ao fechar a janela",
    closeDescriptionMac:
      "Por padrão, o aplicativo continua em execução em segundo plano ao ser fechado. Use o ícone do Dock ou o item da barra de menus para exibi-lo novamente.",
    closeDescriptionOther:
      "Por padrão, o aplicativo permanece na bandeja do sistema ao ser fechado. Clique duas vezes no ícone da bandeja para exibi-lo novamente.",
    closeMinimize: "Manter em execução em segundo plano",
    closeQuit: "Sair do aplicativo",
    saveFailed: "Falha ao salvar: {{error}}",
    configBackup: "Backup da configuração",
    configBackupDescription:
      "Exporte ou importe diretórios e observações dos projetos. As importações são mescladas pelo caminho sem duplicar diretórios.",
    exportFile: "Exportar para arquivo",
    importFile: "Importar de arquivo",
    exported: "Exportado.",
    exportFailed: "Falha na exportação: {{error}}",
    importSuccess: "Importado com sucesso.",
    importFailed: "Falha na importação: {{error}}",
    diagnostics: "Diagnóstico",
    exportDiagnostics: "Exportar relatório de diagnóstico",
    recentLaunch: "Inicializações recentes",
    launchHistoryRetention: "Manter histórico",
    launchHistoryRetentionCount: "Últimas {{count}} inicializações",
    launchHistoryProject: "Projeto: ",
    launchHistoryPath: "Caminho: ",
    launchHistoryTime: "Horário: ",
    launchHistorySessionId: "ID da sessão: ",
    clearHistory: "Limpar histórico",
    resumeSession: "Retomar sessão",
    newSession: "Nova sessão",
    success: "Sucesso",
    failed: "Falha",
    cache: "Cache",
    entries: "Itens: {{count}}",
    size: "Tamanho: {{size}}",
    newestWrite: "Última gravação: {{time}}",
    clearCache: "Limpar cache",
    recovery: "Recuperação de dados",
    recoveryDescription:
      "Pontos de restauração automáticos são criados antes de importações e restaurações. Pontos manuais salvam todos os dados atuais do aplicativo.",
    createRecovery: "Criar ponto de restauração",
    readRecoveryFailed:
      "Não foi possível ler os pontos de restauração: {{error}}",
    restore: "Restaurar",
    confirmRestore: "Restaurar dados?",
    restoreDescription:
      "Restaurar os dados para o estado de {{time}}. O estado atual será salvo automaticamente antes.",
    confirmRestoreAction: "Confirmar restauração",
    restoreFailed: "Falha na restauração: {{error}}",
    backupReason: {
      manual: "Ponto de restauração manual",
      pre_import: "Backup automático antes da importação",
      pre_restore: "Backup de proteção antes da restauração",
      pre_migration: "Backup automático antes da atualização",
    },
    preservation: {
      exact: "Preservado integralmente",
      command_continuation: "Continuação do comando",
      appearance_only: "Somente aparência",
    },
    shell: { custom: "Shell personalizado" },
    terminalDescription: {
      command_document:
        "Abrir pelo LaunchServices um arquivo .command de uso único que se exclui automaticamente",
      apple_script:
        "Criar uma janela nativa do Ghostty e inserir o comando pelo AppleScript",
      direct_arguments:
        "Passar argumentos estruturados pela CLI oficial incluída no pacote do aplicativo",
      kittySuffix: ", mantendo a janela aberta após o término do comando",
      xdg_terminal_exec:
        "Delegar a inicialização ao terminal padrão do ambiente gráfico (xdg-terminal-exec)",
      shell_wrapped: "Executar o comando em uma nova janela com a opção -e",
    },
  },
  about: {
    title: "Sobre",
    version: "Versão {{version}}",
    description:
      "Um espaço de trabalho para desktop centrado em projetos, com suporte a cinco CLIs de IA, terminal incorporado com vários painéis, histórico e recuperação de sessões e layouts reutilizáveis.",
    supportedCli: "CLIs compatíveis",
    repository: "Repositório do projeto",
    repositoryDescription:
      "Confira o código-fonte e as novidades do CLI Launchpad.",
    openRepository: "Ver no GitHub",
    openRepositoryError:
      "Não foi possível abrir o repositório do GitHub no navegador padrão.",
    licenses: "Licenças de código aberto",
    licenseIntro:
      "O CLI Launchpad e os ícones de marca incorporados usam a licença MIT. As fontes incorporadas continuam sujeitas às respectivas licenças SIL Open Font License 1.1.",
  },
  executions: {
    title: "Tarefas",
    description:
      "Veja a saída ao vivo e o histórico das tarefas de instalação e atualização.",
    operationInstall: "instalação",
    operationUpdate: "atualização",
    taskToastTitle: "{{tool}} {{operation}}",
    taskSucceededToast: "{{title}} concluída com sucesso",
    taskFailedToast: "{{title}} falhou",
    taskStoppedToast: "{{title}} foi interrompida",
    refresh: "Atualizar tarefas",
    clearHistory: "Limpar histórico",
    clearAllTitle: "Limpar todas as tarefas concluídas?",
    clearAllDescription:
      "{{count}} tarefas e seus registros serão excluídos permanentemente.",
    clearing: "Limpando…",
    confirmClear: "Limpar tarefas",
    readFailed: "Não foi possível ler as tarefas: {{error}}",
    operationFailed: "Falha na operação: {{error}}",
    listLabel: "Lista de tarefas",
    readingTasks: "Carregando tarefas…",
    emptyTitle: "Ainda não há tarefas",
    emptyDescription:
      "Instale ou atualize uma CLI em Configurações para ver a tarefa aqui.",
    install: "Instalar",
    update: "Atualizar",
    selectTask: "Selecione uma tarefa para ver seus registros.",
    source: "Origem: {{source}}",
    cancelling: "Interrompendo",
    cancelTask: "Interromper tarefa",
    clearRecord: "Excluir registro",
    cancelTitle: "Interromper esta tarefa?",
    cancelDescription:
      "Toda a árvore de processos será encerrada. Interromper uma atualização pode exigir a reinstalação da CLI.",
    requesting: "Solicitando…",
    confirmCancel: "Confirmar interrupção",
    deleteTitle: "Excluir este registro de tarefa?",
    deleteDescription:
      "Os registros históricos correspondentes também serão excluídos permanentemente.",
    deleting: "Excluindo…",
    confirmDelete: "Confirmar exclusão",
    startedAt: "Iniciada em {{time}}",
    exitCode: "Código de saída {{code}}",
    followOutput: "Acompanhar saída mais recente",
    readingLogs: "Carregando registros…",
    noOutput: "(Ainda não há saída)",
    truncated:
      "O registro atingiu o limite de 1 MiB. As saídas seguintes não foram salvas.",
    status: {
      preparing: "Preparando",
      running: "Em execução",
      cancelling: "Interrompendo",
      succeeded: "Concluída com sucesso",
      failed: "Falhou",
      cancelled: "Cancelada",
      timed_out: "Tempo esgotado",
      interrupted: "Interrompida inesperadamente",
    },
    stream: {
      stdout: "Saída",
      stderr: "Erro",
      system: "Sistema",
    },
  },
  workspaceFiles: {
    rightPanelTabs: "Guias do painel direito",
    files: "Arquivos",
    git: "Git",
    gitLater: "O gerenciamento Git estará disponível em uma etapa futura.",
    projectRoot: "Raiz do projeto",
    refresh: "Atualizar",
    showHidden: "Mostrar arquivos ocultos",
    emptyDirectory: "Esta pasta está vazia",
    symlinkDisabled: "Ainda não é possível abrir links simbólicos",
    ignored: "Ignorado",
    closeFile: "Fechar arquivo",
    closeFileNamed: "Fechar {{name}}",
    fileMenu: "Menu da janela do arquivo",
    closeOthers: "Fechar outros conteúdos no painel ({{count}})",
    closeAllInPane: "Fechar todo o conteúdo no painel ({{count}})",
    splitAndMoveRight: "Dividir à direita e mover este arquivo",
    splitAndMoveDown: "Dividir abaixo e mover este arquivo",
    discardChanges:
      "Este arquivo tem alterações não salvas. Fechar e descartá-las?",
    save: "Salvar",
    reload: "Recarregar",
    directoryLimitReached: "Há muitos itens. Exibindo os primeiros 5.000.",
    loadingFile: "Carregando arquivo…",
    fileCannotOpen: "Este arquivo não pode ser aberto aqui",
    imagePreview: "Pré-visualização da imagem",
    unsupported: {
      binary: "O editor de texto não aceita arquivos binários.",
      tooLarge: "O arquivo excede o limite de tamanho da pré-visualização.",
      invalidImage:
        "Os dados da imagem não correspondem à extensão do arquivo.",
      unsupportedImage: "Este formato de imagem não é compatível.",
    },
  },
} satisfies LocaleShape<typeof en>;
