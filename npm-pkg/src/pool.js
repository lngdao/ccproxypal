/**
 * Token Pool — round-robin distribution with health tracking.
 * Mirrors the Rust app's pool algorithm.
 */

export class TokenPool {
  constructor() {
    this.entries = [];
    this.nextIndex = 0;
  }

  /** Exponential backoff: 30s, 1m, 2m, 4m, cap 5m */
  static retryCooldownMs(retryCount) {
    const base = 30_000;
    const max = 5 * 60 * 1000;
    return Math.min(base * (1 << Math.min(retryCount, 10)), max);
  }

  static UNHEALTHY_STALE_TTL = 10 * 60 * 1000; // 10 min
  static PRUNE_TTL = 30 * 60 * 1000; // 30 min

  /** Pick next eligible token via round-robin. */
  nextToken() {
    const now = Date.now();
    const eligible = [];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.expiresAt && now >= e.expiresAt) continue; // expired
      if (e.healthy) { eligible.push(i); continue; }
      // Unhealthy + stale → skip
      if (now - e.providedAt > TokenPool.UNHEALTHY_STALE_TTL) continue;
      // Unhealthy but provider active → eligible after backoff
      if (e.unhealthySince && now - e.unhealthySince >= TokenPool.retryCooldownMs(e.retryCount)) {
        eligible.push(i);
      }
    }
    if (eligible.length === 0) return null;

    const idx = this.nextIndex % eligible.length;
    this.nextIndex = (this.nextIndex + 1) % Number.MAX_SAFE_INTEGER;
    const entry = this.entries[eligible[idx]];
    entry.lastUsed = now;
    return { providerId: entry.providerId, accessToken: entry.accessToken };
  }

  /** Add or update a provider's token. */
  upsert(providerId, accessToken, expiresAt) {
    const now = Date.now();
    const existing = this.entries.find(e => e.providerId === providerId);
    if (existing) {
      const tokenChanged = existing.accessToken !== accessToken;
      existing.accessToken = accessToken;
      existing.expiresAt = expiresAt;
      existing.providedAt = now;
      if (!existing.healthy && tokenChanged) {
        existing.retryCount = 0;
        existing.unhealthySince = now;
      }
    } else {
      this.entries.push({
        providerId, accessToken, expiresAt,
        healthy: true, providedAt: now, lastUsed: null,
        unhealthySince: null, retryCount: 0,
      });
    }
  }

  /** Remove a provider. Returns true if found. */
  remove(providerId) {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.providerId !== providerId);
    return this.entries.length < before;
  }

  /** Mark unhealthy. Returns true if this is a healthy→unhealthy transition. */
  markUnhealthy(providerId) {
    const entry = this.entries.find(e => e.providerId === providerId);
    if (!entry) return false;
    entry.unhealthySince = Date.now();
    if (entry.healthy) {
      entry.healthy = false;
      entry.retryCount = 0;
      return true;
    }
    entry.retryCount++;
    return false;
  }

  /** Mark healthy. Returns true if this is unhealthy→healthy transition. */
  markHealthy(providerId) {
    const entry = this.entries.find(e => e.providerId === providerId);
    if (!entry) return false;
    entry.unhealthySince = null;
    entry.retryCount = 0;
    if (!entry.healthy) {
      entry.healthy = true;
      return true;
    }
    return false;
  }

  /** Remove entries that are unhealthy AND haven't pushed in 30 min. */
  pruneStale() {
    const now = Date.now();
    this.entries = this.entries.filter(e => e.healthy || now - e.providedAt <= TokenPool.PRUNE_TTL);
  }

  healthyCount() {
    return this.entries.filter(e => e.healthy && !(e.expiresAt && Date.now() >= e.expiresAt)).length;
  }

  status() {
    this.pruneStale();
    const now = Date.now();
    return {
      total: this.entries.length,
      healthy: this.healthyCount(),
      providers: this.entries.map(e => {
        const stale = !e.healthy && now - e.providedAt > TokenPool.UNHEALTHY_STALE_TTL;
        return {
          provider_id: e.providerId,
          healthy: e.healthy && !stale,
          stale,
          expired: !!(e.expiresAt && now >= e.expiresAt),
          provided_at: e.providedAt,
          last_used: e.lastUsed,
          expires_at: e.expiresAt,
        };
      }),
    };
  }
}
