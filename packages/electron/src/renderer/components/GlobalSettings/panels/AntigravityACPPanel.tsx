import type { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';

interface AntigravityACPPanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (provider: string, value: string) => void;
  onTestConnection: () => Promise<void>;
}

export function AntigravityACPPanel({
  config, apiKeys, onToggle, onApiKeyChange, onTestConnection,
}: AntigravityACPPanelProps) {
  return (
    <div className="provider-panel antigravity-acp-panel flex flex-col gap-4">
      <h3 className="text-xl font-semibold">Google Antigravity CLI</h3>
      <p className="text-sm text-[var(--nim-text-muted)]">
        Install the Antigravity CLI on the host running Marilyst and verify that <code>agy acp --help</code> works.
        Set <code>modelProvider</code> to <code>gemini</code> in the CLI settings and use a Gemini API key from Google AI Studio.
      </p>
      <SettingsToggle variant="enable" name="Enable Antigravity CLI" checked={config.enabled} onChange={onToggle} />
      {config.enabled && (
        <div className="flex flex-col items-start gap-2">
          <label htmlFor="antigravity-acp-key">Gemini API key</label>
          <input
            id="antigravity-acp-key"
            className="w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2"
            type="password"
            autoComplete="off"
            placeholder="Enter a Gemini API key"
            value={apiKeys['antigravity-acp'] || ''}
            onChange={(event) => onApiKeyChange('antigravity-acp', event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-[var(--nim-border)] px-3 py-2"
            disabled={config.testStatus === 'testing'}
            onClick={() => void onTestConnection()}
          >
            {config.testStatus === 'testing' ? 'Checking setup…' : 'Check setup'}
          </button>
          {config.testMessage && <p role="status" className="text-sm">{config.testMessage}</p>}
        </div>
      )}
    </div>
  );
}
