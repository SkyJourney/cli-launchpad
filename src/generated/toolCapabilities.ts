// 由 scripts/gen-contracts.mjs 生成，请勿手改。来源：contracts/tool-capabilities.json（测试变体另含 src/test/fixtures/tool-capabilities.json）
export const TOOL_CAPABILITY_ITEMS = [
  {
    "toolKey": "claude",
    "apiVersion": 1,
    "capabilities": {
      "history": true,
      "resume": true,
      "updateSemantics": "version",
      "managedUpdate": {
        "mode": "always"
      },
      "installEffectsKey": null
    }
  },
  {
    "toolKey": "codex",
    "apiVersion": 1,
    "capabilities": {
      "history": true,
      "resume": true,
      "updateSemantics": "version",
      "managedUpdate": {
        "mode": "always"
      },
      "installEffectsKey": null
    }
  },
  {
    "toolKey": "antigravity",
    "apiVersion": 1,
    "capabilities": {
      "history": true,
      "resume": true,
      "updateSemantics": "version",
      "managedUpdate": {
        "mode": "always"
      },
      "installEffectsKey": null
    }
  },
  {
    "toolKey": "grok",
    "apiVersion": 1,
    "capabilities": {
      "history": true,
      "resume": true,
      "updateSemantics": "version",
      "managedUpdate": {
        "mode": "sourceVerified",
        "deniedReasonKey": "settings.grokUpdateSourceDenied"
      },
      "installEffectsKey": "grok"
    }
  },
  {
    "toolKey": "hermes",
    "apiVersion": 1,
    "capabilities": {
      "history": true,
      "resume": true,
      "updateSemantics": "branch",
      "managedUpdate": {
        "mode": "sourceVerified",
        "deniedReasonKey": "settings.hermesUpdateSourceDenied"
      },
      "installEffectsKey": "hermes"
    }
  }
] as const;
