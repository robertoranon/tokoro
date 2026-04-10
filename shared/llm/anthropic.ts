import Anthropic from '@anthropic-ai/sdk';
import {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  LLMMessageContent,
  LLMContentBlock,
} from '../types/llm';

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  get name(): string {
    return this.model;
  }

  constructor(config: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model || 'claude-3-5-sonnet-20241022';
  }

  private convertMessageContent(content: LLMMessageContent): string | Anthropic.MessageParam['content'] {
    if (typeof content === 'string') return content;
    return content.map((block: LLMContentBlock) => {
      if (block.type === 'text') return { type: 'text' as const, text: block.text };
      if (block.type === 'image') {
        if (block.source.type === 'url') throw new Error('URL-based images not supported by Anthropic. Provide base64 data.');
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: block.source.data!,
          },
        };
      }
      throw new Error(`Unknown content block type: ${(block as any).type}`);
    });
  }

  async complete(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');
    const systemContent = systemMessage?.content;
    const systemString = typeof systemContent === 'string'
      ? systemContent
      : systemContent?.find(block => block.type === 'text')?.text ?? '';
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 2000,
      temperature: options.temperature ?? 0.1,
      system: systemString,
      messages: conversationMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: this.convertMessageContent(m.content),
      })),
    });
    const content = response.content[0];
    if (content.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    return {
      content: content.text,
      model: response.model,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }
}
