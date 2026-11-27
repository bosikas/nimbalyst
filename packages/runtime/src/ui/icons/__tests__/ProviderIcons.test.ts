import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderIcon, resolveProviderIcon } from '../ProviderIcons';

describe('resolveProviderIcon', () => {
  it('maps the Codex ACP provider to the shared Codex icon', () => {
    expect(resolveProviderIcon('openai-codex-acp')).toBe('openai-codex');
  });

  it('leaves other provider ids unchanged', () => {
    expect(resolveProviderIcon('openai')).toBe('openai');
    expect(resolveProviderIcon('claude-code')).toBe('claude-code');
  });
});

it('renders the Vibe transcript icon within the requested dimensions', () => {
  const markup = renderToStaticMarkup(createElement(ProviderIcon, { provider: 'mistral-vibe', size: 18 }));
  expect(markup).toContain('<svg width="18" height="18" viewBox="0 0 24 24"');
  expect(markup).not.toContain('material-symbols-outlined');
});
