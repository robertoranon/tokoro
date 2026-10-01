import { LLMProvider, LLMProviderType } from '../types/llm';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_MODELS,
  DEFAULT_OLLAMA_BASE_URL,
} from './defaults';

export interface LLMConfig {
  provider?: string; // 'openai' | 'anthropic' | 'openrouter' | 'ollama' — default comes from ./defaults
  apiKey?: string;
  model?: string;
  ollamaBaseUrl?: string;
}

export function createLLMProvider(config: LLMConfig): LLMProvider {
  const provider = (config.provider || DEFAULT_LLM_PROVIDER) as LLMProviderType;

  switch (provider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
        model: config.model || DEFAULT_LLM_MODELS.ollama,
      });

    case 'openai':
      if (!config.apiKey) throw new Error('apiKey is required for OpenAI');
      return new OpenAIProvider({
        apiKey: config.apiKey,
        model: config.model || DEFAULT_LLM_MODELS.openai,
      });

    case 'openrouter':
      if (!config.apiKey) throw new Error('apiKey is required for OpenRouter');
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        model: config.model || DEFAULT_LLM_MODELS.openrouter,
      });

    case 'anthropic':
      if (!config.apiKey) throw new Error('apiKey is required for Anthropic');
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model || DEFAULT_LLM_MODELS.anthropic,
      });

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
