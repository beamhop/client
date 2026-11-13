/**
 * Env vars that point each harness at the local broker with a placeholder key.
 * The placeholder is a per-session token minted by `LlmProxy.createSession()`.
 */
export const envForHarness = (
  harnessId: string,
  proxyUrl: string,
  placeholder: string,
): Record<string, string> => {
  const base = proxyUrl.replace(/\/$/, '');
  const id = harnessId.toLowerCase();
  const anthropic = {
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    ANTHROPIC_API_KEY: placeholder,
    ANTHROPIC_CUSTOM_HEADERS: `x-beamhop-session: ${placeholder}`,
  };
  const openai = {
    OPENAI_BASE_URL: `${base}/openai/v1`,
    OPENAI_API_KEY: placeholder,
  };
  const openrouterUrl = `${base}/openrouter/api/v1`;
  if (id === 'claude' || id.startsWith('claude-')) {
    // Claude Code: base URL + key; skip telemetry/update traffic the sandbox would block anyway.
    return { ...anthropic, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  }
  if (id === 'codex' || id.startsWith('codex-')) {
    // Codex CLI honours OPENAI_BASE_URL / OPENAI_API_KEY (and CODEX_API_KEY in exec mode).
    return { ...openai, CODEX_API_KEY: placeholder };
  }
  if (id === 'opencode') {
    // opencode merges OPENCODE_CONFIG_CONTENT into its config; point the openrouter
    // provider (and anthropic/openai, if selected) at the broker.
    const config = {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        openrouter: { options: { baseURL: openrouterUrl, apiKey: placeholder } },
        anthropic: { options: { baseURL: `${base}/anthropic/v1`, apiKey: placeholder } },
        openai: { options: { baseURL: `${base}/openai/v1`, apiKey: placeholder } },
      },
    };
    return {
      OPENROUTER_API_KEY: placeholder,
      ...anthropic,
      ...openai,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
  }
  if (id === 'pi') {
    // pi reads keys from env; base URLs come from models.json in PI_CODING_AGENT_DIR
    // (write `piModelsJson()` there). PI_OFFLINE disables startup update checks.
    return { OPENROUTER_API_KEY: placeholder, ...anthropic, ...openai, PI_OFFLINE: '1' };
  }
  // ACP / unknown harnesses: export every convention we know.
  return { ...anthropic, ...openai, OPENROUTER_API_KEY: placeholder, OPENROUTER_BASE_URL: openrouterUrl };
};

/** `models.json` for pi (place in `$PI_CODING_AGENT_DIR`): built-in providers re-pointed at the broker. */
export const piModelsJson = (proxyUrl: string): string => {
  const base = proxyUrl.replace(/\/$/, '');
  return JSON.stringify(
    {
      providers: {
        openrouter: { baseUrl: `${base}/openrouter/api/v1` },
        anthropic: { baseUrl: `${base}/anthropic` },
        openai: { baseUrl: `${base}/openai/v1` },
      },
    },
    null,
    2,
  );
};
