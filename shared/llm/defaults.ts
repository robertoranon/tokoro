/**
 * Default LLM configuration — the single source of truth.
 *
 * Edit this file to change the default LLM everywhere (crawler, worker,
 * crawler-worker, dev scripts). Environment variables (LLM_PROVIDER,
 * LLM_MODEL, ...) still override these values at runtime.
 *
 * A test (crawler/tests/test-llm-defaults.ts) fails if these values are
 * hard-coded anywhere else, so keep them only here.
 */

/** Provider used when LLM_PROVIDER / config.provider is unset. */
export const DEFAULT_LLM_PROVIDER = 'openrouter' as const;

/** Default model for each provider, used when no model is configured. */
export const DEFAULT_LLM_MODELS = {
  openrouter: 'openai/gpt-6-luna',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-20241022',
  ollama: 'llama3.1',
} as const;

/** Default Ollama server URL. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/** The one value most people want to change: the model used when LLM_PROVIDER is unset or the default provider. */
export const DEFAULT_LLM_MODEL = DEFAULT_LLM_MODELS[DEFAULT_LLM_PROVIDER];

/** Default model for a provider name, or undefined for an unknown provider. */
export function defaultModelFor(provider: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DEFAULT_LLM_MODELS, provider)
    ? DEFAULT_LLM_MODELS[provider as keyof typeof DEFAULT_LLM_MODELS]
    : undefined;
}
