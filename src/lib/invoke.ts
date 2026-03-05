import { invoke } from "@tauri-apps/api/core";

export interface AppStatus {
  proxy_running: boolean;
  proxy_port: number;
  token_valid: boolean;
  token_expires_at: number | null;
  tunnel_running: boolean;
  tunnel_url: string | null;
  telegram_running: boolean;
}

export interface TokenStatus {
  valid: boolean;
  expires_at: number | null;
  error: string | null;
}

export interface ProxyConfig {
  port: number;
  claude_code_first: boolean;
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  openai_base_url: string;
  allowed_ips: string[];
  budget_hourly: number | null;
  budget_daily: number | null;
  budget_weekly: number | null;
  budget_monthly: number | null;
}

export interface RequestRecord {
  id: number;
  timestamp: number;
  model: string;
  source: "claude_code" | "api_key" | "error";
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  stream: boolean;
  latency_ms: number | null;
  error: string | null;
}

export interface AnalyticsSummary {
  total_requests: number;
  claude_code_requests: number;
  api_key_requests: number;
  error_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  estimated_savings: number;
  requests: RequestRecord[];
}

export interface BudgetSettings {
  budget_hourly: number | null;
  budget_daily: number | null;
  budget_weekly: number | null;
  budget_monthly: number | null;
}

export interface TelegramConfig {
  bot_token: string | null;
  allowed_user_ids: number[];
  enabled: boolean;
}

export interface TelegramStatus {
  running: boolean;
  bot_token_set: boolean;
  allowed_users_count: number;
}

export const api = {
  getStatus: () => invoke<AppStatus>("get_status"),
  refreshToken: () => invoke<TokenStatus>("refresh_token"),
  loadToken: () => invoke<TokenStatus>("load_token"),

  startProxy: () => invoke<string>("start_proxy"),
  stopProxy: () => invoke<string>("stop_proxy"),

  startTunnel: () => invoke<string>("start_tunnel"),
  stopTunnel: () => invoke<string>("stop_tunnel"),
  getTunnelUrl: () => invoke<string | null>("get_tunnel_url"),
  isCloudflaredAvailable: () => invoke<boolean>("is_cloudflared_available"),

  getSettings: () => invoke<ProxyConfig>("get_settings"),
  saveSettings: (config: ProxyConfig) => invoke<string>("save_settings", { config }),

  getAnalytics: (period?: string, limit?: number) =>
    invoke<AnalyticsSummary>("get_analytics", { period, limit }),
  resetAnalytics: () => invoke<string>("reset_analytics"),

  getBudget: () => invoke<BudgetSettings>("get_budget"),
  saveBudget: (budget: BudgetSettings) => invoke<string>("save_budget", { budget }),

  getTelegramConfig: () => invoke<TelegramConfig>("get_telegram_config"),
  saveTelegramConfig: (config: TelegramConfig) =>
    invoke<string>("save_telegram_config", { config }),
  startTelegramBot: () => invoke<string>("start_telegram_bot"),
  stopTelegramBot: () => invoke<string>("stop_telegram_bot"),
  getTelegramStatus: () => invoke<TelegramStatus>("get_telegram_status"),
};
