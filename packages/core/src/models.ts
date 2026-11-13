/**
 * Context window (tokens) of well-known model families, for sizing the history replayed into a harness.
 * Matched on the model id without a provider prefix (`anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`);
 * unknown models and the harness's own default get `FALLBACK_CONTEXT_WINDOW`.
 */
const WINDOWS: [RegExp, number][] = [
  [/^claude-.*\[1m\]$/, 1_000_000],
  [/^(claude|sonnet|opus|haiku|fable)/, 200_000],
  [/^gpt-5/, 400_000],
  [/^gpt-4\.1/, 1_000_000],
  [/^(gpt-4o|o1|o3|o4)/, 128_000],
  [/^codex/, 200_000],
  [/^gemini/, 1_000_000],
  [/^(grok-4|grok-code)/, 256_000],
  [/^(deepseek|qwen|kimi|glm|mistral|devstral|llama)/, 128_000],
];

export const FALLBACK_CONTEXT_WINDOW = 128_000;

export const modelContextWindow = (model: string | undefined): number => {
  if (!model) return FALLBACK_CONTEXT_WINDOW;
  const id = model.toLowerCase().split('/').pop() ?? '';
  return WINDOWS.find(([re]) => re.test(id))?.[1] ?? FALLBACK_CONTEXT_WINDOW;
};
