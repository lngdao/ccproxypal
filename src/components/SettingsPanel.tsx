import { useEffect, useState } from "react";
import { api, ProxyConfig, BudgetSettings, TelegramConfig } from "../lib/invoke";

export default function SettingsPanel() {
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [telegram, setTelegram] = useState<TelegramConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getSettings(), api.getBudget(), api.getTelegramConfig()]).then(
      ([cfg, bud, tg]) => {
        setConfig(cfg);
        setBudget(bud);
        setTelegram(tg);
      }
    );
  }, []);

  const handleSave = async () => {
    if (!config || !budget || !telegram) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(config);
      await api.saveBudget(budget);
      await api.saveTelegramConfig(telegram);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!config || !budget || !telegram) return <div className="loading">Loading...</div>;

  return (
    <div className="settings">
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="card-title">Proxy Server</div>
        <div className="form-group">
          <label>Port</label>
          <input
            type="number"
            value={config.port}
            onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 8082 })}
            min={1024}
            max={65535}
          />
          <span className="hint">Port for the local proxy server (default: 8082)</span>
        </div>

        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={config.claude_code_first}
              onChange={(e) => setConfig({ ...config, claude_code_first: e.target.checked })}
            />
            Use Claude Code subscription first
          </label>
          <span className="hint">Try OAuth subscription before falling back to API key</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">API Keys (Fallback)</div>
        <div className="form-group">
          <label>Anthropic API Key</label>
          <input
            type="password"
            value={config.anthropic_api_key ?? ""}
            placeholder="sk-ant-api..."
            onChange={(e) =>
              setConfig({ ...config, anthropic_api_key: e.target.value || null })
            }
          />
          <span className="hint">Used as fallback when Claude Code OAuth is rate-limited</span>
        </div>

        <div className="form-group">
          <label>OpenAI Base URL</label>
          <input
            type="text"
            value={config.openai_base_url}
            onChange={(e) => setConfig({ ...config, openai_base_url: e.target.value })}
          />
        </div>

        <div className="form-group">
          <label>OpenAI API Key</label>
          <input
            type="password"
            value={config.openai_api_key ?? ""}
            placeholder="sk-..."
            onChange={(e) =>
              setConfig({ ...config, openai_api_key: e.target.value || null })
            }
          />
          <span className="hint">For non-Claude model passthrough (GPT, Gemini, etc.)</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Access Control</div>
        <div className="form-group">
          <label>Allowed IPs (Cloudflare Tunnel)</label>
          <textarea
            value={config.allowed_ips.join("\n")}
            rows={4}
            onChange={(e) =>
              setConfig({
                ...config,
                allowed_ips: e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <span className="hint">
            One IP per line. <code>0.0.0.0</code> or <code>*</code> or empty = allow all.
            Only enforced for tunnel requests (Cloudflare). Local requests always allowed.
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Spending Limits (API Key Fallback)</div>
        <div className="form-row">
          <div className="form-group">
            <label>Hourly ($)</label>
            <input
              type="number"
              value={budget.budget_hourly ?? ""}
              placeholder="No limit"
              min={0}
              step={0.01}
              onChange={(e) =>
                setBudget({
                  ...budget,
                  budget_hourly: e.target.value ? parseFloat(e.target.value) : null,
                })
              }
            />
          </div>
          <div className="form-group">
            <label>Daily ($)</label>
            <input
              type="number"
              value={budget.budget_daily ?? ""}
              placeholder="No limit"
              min={0}
              step={0.01}
              onChange={(e) =>
                setBudget({
                  ...budget,
                  budget_daily: e.target.value ? parseFloat(e.target.value) : null,
                })
              }
            />
          </div>
          <div className="form-group">
            <label>Weekly ($)</label>
            <input
              type="number"
              value={budget.budget_weekly ?? ""}
              placeholder="No limit"
              min={0}
              step={0.01}
              onChange={(e) =>
                setBudget({
                  ...budget,
                  budget_weekly: e.target.value ? parseFloat(e.target.value) : null,
                })
              }
            />
          </div>
          <div className="form-group">
            <label>Monthly ($)</label>
            <input
              type="number"
              value={budget.budget_monthly ?? ""}
              placeholder="No limit"
              min={0}
              step={0.01}
              onChange={(e) =>
                setBudget({
                  ...budget,
                  budget_monthly: e.target.value ? parseFloat(e.target.value) : null,
                })
              }
            />
          </div>
        </div>
        <span className="hint">Limits only apply to paid API key requests. Claude Code usage is free.</span>
      </div>

      {/* Telegram Bot */}
      <div className="card">
        <div className="card-title">Telegram Bot</div>
        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={telegram.enabled}
              onChange={(e) => setTelegram({ ...telegram, enabled: e.target.checked })}
            />
            Enable Telegram bot
          </label>
          <span className="hint">
            Lets authorized users check status and get tokens via Telegram
          </span>
        </div>

        <div className="form-group">
          <label>Bot Token</label>
          <input
            type="password"
            value={telegram.bot_token ?? ""}
            placeholder="1234567890:ABCdef..."
            onChange={(e) =>
              setTelegram({ ...telegram, bot_token: e.target.value || null })
            }
          />
          <span className="hint">
            Get a token from <code>@BotFather</code> on Telegram. Keep it secret.
          </span>
        </div>

        <div className="form-group">
          <label>Allowed Telegram User IDs</label>
          <textarea
            value={telegram.allowed_user_ids.join("\n")}
            rows={3}
            placeholder={"123456789\n987654321"}
            onChange={(e) =>
              setTelegram({
                ...telegram,
                allowed_user_ids: e.target.value
                  .split("\n")
                  .map((s) => parseInt(s.trim()))
                  .filter((n) => !isNaN(n) && n > 0),
              })
            }
          />
          <span className="hint">
            One Telegram user ID per line. Leave empty to allow everyone (not recommended).
            Find your ID by messaging <code>@userinfobot</code>.
          </span>
        </div>

        <div className="hint">
          Bot commands: <code>/status</code> <code>/token</code> <code>/url</code>{" "}
          <code>/refresh</code> <code>/help</code>
        </div>
      </div>

      <div className="save-row">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
        </button>
        <span className="hint">Restart the proxy after changing port.</span>
      </div>
    </div>
  );
}
