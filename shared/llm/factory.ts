import { LLMProvider, LLMProviderType } from '../types/llm';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';

export interface LLMConfig {
  provider?: string;   // 'openai' | 'anthropic' | 'openrouter' | 'ollama' — defaults to 'openrouter'
  apiKey?: string;
  model?: string;
  ollamaBaseUrl?: string;
}

export function createLLMProvider(config: LLMConfig): LLMProvider {
  const provider = (config.provider || 'openrouter') as LLMProviderType;

  switch (provider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.ollamaBaseUrl || 'http://localhost:11434',
        model: config.model || 'llama3.1',
      });

    case 'openai':
      if (!config.apiKey) throw new Error('apiKey is required for OpenAI');
      return new OpenAIProvider({ apiKey: config.apiKey, model: config.model || 'gpt-4o-mini' });

    case 'openrouter':
      if (!config.apiKey) throw new Error('apiKey is required for OpenRouter');
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        model: config.model || 'google/gemini-2.5-flash-lite',
      });

    case 'anthropic':
      if (!config.apiKey) throw new Error('apiKey is required for Anthropic');
      return new AnthropicProvider({ apiKey: config.apiKey, model: config.model || 'claude-3-5-sonnet-20241022' });

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
