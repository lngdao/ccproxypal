import { useEffect, useState } from "react";
import { api, ProxyConfig, BudgetSettings, TelegramConfig } from "../lib/invoke";
import Card, { CardTitle } from "./ui/Card";
import Button from "./ui/Button";
import Input, { TextArea } from "./ui/Input";
import { toast } from "./ui/Toast";

export default function SettingsPanel() {
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [telegram, setTelegram] = useState<TelegramConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getSettings(),
      api.getBudget(),
      api.getTelegramConfig(),
    ]).then(([cfg, bud, tg]) => {
      setConfig(cfg);
      setBudget(bud);
      setTelegram(tg);
    });
  }, []);

  const handleSave = async () => {
    if (!config || !budget || !telegram) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(config);
      await api.saveBudget(budget);
      await api.saveTelegramConfig(telegram);
      toast.success("Settings saved");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!config || !budget || !telegram) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4 max-w-2xl mx-auto pb-20">
      {error && (
        <div className="bg-text-red/10 border border-text-red/30 text-text-red text-[12px] px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      {/* Proxy Server */}
      <Card>
        <CardTitle>Proxy Server</CardTitle>
        <div className="space-y-4 mt-3">
          <Input
            label="Port"
            type="number"
            value={config.port}
            onChange={(e) =>
              setConfig({
                ...config,
                port: parseInt(e.target.value) || 8082,
              })
            }
            min={1024}
            max={65535}
            hint="Port for the local proxy server (default: 8082)"
          />

          <label className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={config.claude_code_first}
              onChange={(e) =>
                setConfig({ ...config, claude_code_first: e.target.checked })
              }
              className="w-3.5 h-3.5 rounded border-border accent-accent"
            />
            Use Claude Code subscription first
          </label>
          <p className="text-[11px] text-text-muted -mt-2 ml-5">
            Try OAuth subscription before falling back to API key
          </p>

          <label className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={config.strip_unsupported_fields}
              onChange={(e) =>
                setConfig({
                  ...config,
                  strip_unsupported_fields: e.target.checked,
                })
              }
              className="w-3.5 h-3.5 rounded border-border accent-accent"
            />
            Strip unsupported fields
          </label>
          <p className="text-[11px] text-text-muted -mt-2 ml-5">
            Enable if you see "No API key available and Claude Code OAuth failed"
            errors
          </p>
        </div>
      </Card>

      {/* API Keys */}
      <Card>
        <CardTitle>API Keys (Fallback)</CardTitle>
        <div className="space-y-4 mt-3">
          <Input
            label="Anthropic API Key"
            type="password"
            value={config.anthropic_api_key ?? ""}
            placeholder="sk-ant-api..."
            onChange={(e) =>
              setConfig({
                ...config,
                anthropic_api_key: e.target.value || null,
              })
            }
            hint="Used as fallback when Claude Code OAuth is rate-limited"
          />
          <Input
            label="OpenAI Base URL"
            value={config.openai_base_url}
            onChange={(e) =>
              setConfig({ ...config, openai_base_url: e.target.value })
            }
          />
          <Input
            label="OpenAI API Key"
            type="password"
            value={config.openai_api_key ?? ""}
            placeholder="sk-..."
            onChange={(e) =>
              setConfig({
                ...config,
                openai_api_key: e.target.value || null,
              })
            }
            hint="For non-Claude model passthrough (GPT, Gemini, etc.)"
          />
        </div>
      </Card>

      {/* Security */}
      <Card>
        <CardTitle>Security</CardTitle>
        <div className="space-y-4 mt-3">
          <Input
            label="Hub Secret"
            type="password"
            value={config.hub_secret ?? ""}
            placeholder="Leave empty for no auth"
            onChange={(e) =>
              setConfig({
                ...config,
                hub_secret: e.target.value || null,
              })
            }
            hint={
              <>
                Shared secret for hub provider API. Leave empty to allow
                unauthenticated access.
              </>
            }
          />
          <TextArea
            label="Allowed IPs (Cloudflare Tunnel)"
            value={config.allowed_ips.join("\n")}
            rows={3}
            onChange={(e) =>
              setConfig({
                ...config,
                allowed_ips: e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            hint={
              <>
                One IP per line. <code>0.0.0.0</code> or <code>*</code> or empty
                = allow all. Only enforced for tunnel requests.
              </>
            }
          />
        </div>
      </Card>

      {/* Budget Limits */}
      <Card>
        <CardTitle>Budget Limits</CardTitle>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Input
            label="Hourly ($)"
            type="number"
            value={budget.budget_hourly ?? ""}
            placeholder="No limit"
            min={0}
            step={0.01}
            onChange={(e) =>
              setBudget({
                ...budget,
                budget_hourly: e.target.value
                  ? parseFloat(e.target.value)
                  : null,
              })
            }
          />
          <Input
            label="Daily ($)"
            type="number"
            value={budget.budget_daily ?? ""}
            placeholder="No limit"
            min={0}
            step={0.01}
            onChange={(e) =>
              setBudget({
                ...budget,
                budget_daily: e.target.value
                  ? parseFloat(e.target.value)
                  : null,
              })
            }
          />
          <Input
            label="Weekly ($)"
            type="number"
            value={budget.budget_weekly ?? ""}
            placeholder="No limit"
            min={0}
            step={0.01}
            onChange={(e) =>
              setBudget({
                ...budget,
                budget_weekly: e.target.value
                  ? parseFloat(e.target.value)
                  : null,
              })
            }
          />
          <Input
            label="Monthly ($)"
            type="number"
            value={budget.budget_monthly ?? ""}
            placeholder="No limit"
            min={0}
            step={0.01}
            onChange={(e) =>
              setBudget({
                ...budget,
                budget_monthly: e.target.value
                  ? parseFloat(e.target.value)
                  : null,
              })
            }
          />
        </div>
        <p className="text-[11px] text-text-muted mt-2">
          Limits only apply to paid API key requests. Claude Code usage is free.
        </p>
      </Card>

      {/* Integrations: Telegram */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <CardTitle>Integrations</CardTitle>
        </div>

        {/* Telegram section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text-secondary uppercase tracking-wider">
              Telegram Bot
            </span>
            <label className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={telegram.enabled}
                onChange={(e) =>
                  setTelegram({ ...telegram, enabled: e.target.checked })
                }
                className="w-3.5 h-3.5 rounded border-border accent-accent"
              />
              Enabled
            </label>
          </div>

          <Input
            label="Bot Token"
            type="password"
            value={telegram.bot_token ?? ""}
            placeholder="1234567890:ABCdef..."
            onChange={(e) =>
              setTelegram({
                ...telegram,
                bot_token: e.target.value || null,
              })
            }
            hint={
              <>
                Get a token from <code>@BotFather</code> on Telegram.
              </>
            }
          />

          <TextArea
            label="Allowed User IDs"
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
            hint={
              <>
                One user ID per line. Find yours via{" "}
                <code>@userinfobot</code>. Empty = allow all (not
                recommended).
              </>
            }
          />

          <div className="space-y-1">
            <span className="text-[12px] font-medium text-text-secondary">
              Commands
            </span>
            <div className="flex flex-wrap gap-1.5">
              {["/status", "/start", "/stop", "/tunnel", "/pool", "/usage", "/help"].map(
                (cmd) => (
                  <code
                    key={cmd}
                    className="text-[11px] px-2 py-0.5 rounded bg-bg-elevated border border-border text-text-muted"
                  >
                    {cmd}
                  </code>
                )
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Sticky save button */}
      <div className="fixed bottom-[26px] left-[48px] right-0 bg-bg/90 backdrop-blur-sm border-t border-border px-5 py-3 flex items-center gap-3">
        <Button variant="primary" loading={saving} onClick={handleSave}>
          Save Settings
        </Button>
        <span className="text-[11px] text-text-muted">
          Restart the proxy after changing port.
        </span>
      </div>
    </div>
  );
}
