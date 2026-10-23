// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/tool-keys.json 与适配器模块
import type { CliAdapter } from "../lib/cliAdapters/types";
import type { RegisteredToolKey } from "./toolKeys";
import { claudeAdapter } from "../lib/cliAdapters/claude";
import { codexAdapter } from "../lib/cliAdapters/codex";
import { antigravityAdapter } from "../lib/cliAdapters/antigravity";
import { grokAdapter } from "../lib/cliAdapters/grok";
import { hermesAdapter } from "../lib/cliAdapters/hermes";

export const CLI_ADAPTERS_BY_KEY: Record<RegisteredToolKey, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
  grok: grokAdapter,
  hermes: hermesAdapter,
};
