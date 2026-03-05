use anyhow::Result;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            model TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('claude_code', 'api_key', 'error')),
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            estimated_cost REAL DEFAULT 0,
            stream INTEGER DEFAULT 0,
            latency_ms INTEGER,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS budget_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            budget_hourly REAL,
            budget_daily REAL,
            budget_weekly REAL,
            budget_monthly REAL
        );
        INSERT OR IGNORE INTO budget_settings (id) VALUES (1);",
    )?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RequestRecord {
    pub id: i64,
    pub timestamp: i64,
    pub model: String,
    pub source: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub estimated_cost: f64,
    pub stream: bool,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalyticsSummary {
    pub total_requests: i64,
    pub claude_code_requests: i64,
    pub api_key_requests: i64,
    pub error_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost: f64,
    pub estimated_savings: f64,
    pub requests: Vec<RequestRecord>,
}

pub struct NewRequest<'a> {
    pub model: &'a str,
    pub source: &'a str,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub stream: bool,
    pub latency_ms: Option<i64>,
    pub error: Option<&'a str>,
    pub estimated_cost: f64,
}

pub fn record_request(conn: &Connection, req: NewRequest) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO requests (timestamp, model, source, input_tokens, output_tokens, estimated_cost, stream, latency_ms, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            now,
            req.model,
            req.source,
            req.input_tokens,
            req.output_tokens,
            req.estimated_cost,
            req.stream as i64,
            req.latency_ms,
            req.error,
        ],
    )?;
    Ok(())
}

pub fn get_analytics(conn: &Connection, period: &str, limit: usize) -> Result<AnalyticsSummary> {
    let cutoff = match period {
        "hour" => chrono::Utc::now().timestamp_millis() - 3_600_000,
        "day" => chrono::Utc::now().timestamp_millis() - 86_400_000,
        "week" => chrono::Utc::now().timestamp_millis() - 604_800_000,
        "month" => chrono::Utc::now().timestamp_millis() - 2_592_000_000,
        _ => 0, // "all"
    };

    let mut stmt = conn.prepare(
        "SELECT id, timestamp, model, source, input_tokens, output_tokens, estimated_cost, stream, latency_ms, error
         FROM requests WHERE timestamp >= ?1 ORDER BY timestamp DESC LIMIT ?2",
    )?;

    let requests: Vec<RequestRecord> = stmt
        .query_map(params![cutoff, limit as i64], |row| {
            Ok(RequestRecord {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                model: row.get(2)?,
                source: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                estimated_cost: row.get(6)?,
                stream: row.get::<_, i64>(7)? != 0,
                latency_ms: row.get(8)?,
                error: row.get(9)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Aggregate stats
    let mut stmt2 = conn.prepare(
        "SELECT
            COUNT(*),
            SUM(CASE WHEN source='claude_code' THEN 1 ELSE 0 END),
            SUM(CASE WHEN source='api_key' THEN 1 ELSE 0 END),
            SUM(CASE WHEN source='error' THEN 1 ELSE 0 END),
            SUM(input_tokens),
            SUM(output_tokens),
            SUM(estimated_cost)
         FROM requests WHERE timestamp >= ?1",
    )?;

    let (total, cc, ak, err, inp, out, cost) = stmt2.query_row(params![cutoff], |row| {
        Ok((
            row.get::<_, i64>(0).unwrap_or(0),
            row.get::<_, i64>(1).unwrap_or(0),
            row.get::<_, i64>(2).unwrap_or(0),
            row.get::<_, i64>(3).unwrap_or(0),
            row.get::<_, i64>(4).unwrap_or(0),
            row.get::<_, i64>(5).unwrap_or(0),
            row.get::<_, f64>(6).unwrap_or(0.0),
        ))
    })?;

    // Savings = what api_key requests would have cost (estimate: cc requests billed at api_key rate)
    // Simple estimate: claude_code tokens * average api_key pricing (~$3/MTok input, $15/MTok output)
    let savings = (inp as f64 / 1_000_000.0) * 3.0 + (out as f64 / 1_000_000.0) * 15.0 - cost;

    Ok(AnalyticsSummary {
        total_requests: total,
        claude_code_requests: cc,
        api_key_requests: ak,
        error_requests: err,
        total_input_tokens: inp,
        total_output_tokens: out,
        total_cost: cost,
        estimated_savings: savings.max(0.0),
        requests,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BudgetSettings {
    pub budget_hourly: Option<f64>,
    pub budget_daily: Option<f64>,
    pub budget_weekly: Option<f64>,
    pub budget_monthly: Option<f64>,
}

pub fn get_budget(conn: &Connection) -> Result<BudgetSettings> {
    let settings = conn.query_row(
        "SELECT budget_hourly, budget_daily, budget_weekly, budget_monthly FROM budget_settings WHERE id=1",
        [],
        |row| {
            Ok(BudgetSettings {
                budget_hourly: row.get(0)?,
                budget_daily: row.get(1)?,
                budget_weekly: row.get(2)?,
                budget_monthly: row.get(3)?,
            })
        },
    )?;
    Ok(settings)
}

pub fn save_budget(conn: &Connection, b: &BudgetSettings) -> Result<()> {
    conn.execute(
        "UPDATE budget_settings SET budget_hourly=?1, budget_daily=?2, budget_weekly=?3, budget_monthly=?4 WHERE id=1",
        params![b.budget_hourly, b.budget_daily, b.budget_weekly, b.budget_monthly],
    )?;
    Ok(())
}

pub fn reset_analytics(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM requests", [])?;
    Ok(())
}

/// Check if spending is within budget. Returns error message if budget exceeded.
pub fn check_budget(conn: &Connection) -> Result<Option<String>> {
    let budget = get_budget(conn)?;

    let check = |window_ms: i64, limit: f64, label: &str| -> Result<Option<String>> {
        let cutoff = chrono::Utc::now().timestamp_millis() - window_ms;
        let spent: f64 = conn.query_row(
            "SELECT COALESCE(SUM(estimated_cost), 0) FROM requests WHERE source='api_key' AND timestamp >= ?1",
            params![cutoff],
            |row| row.get(0),
        )?;
        if spent >= limit {
            Ok(Some(format!("{} budget limit of ${:.2} reached (spent ${:.2})", label, limit, spent)))
        } else {
            Ok(None)
        }
    };

    if let Some(limit) = budget.budget_hourly {
        if let Some(msg) = check(3_600_000, limit, "Hourly")? {
            return Ok(Some(msg));
        }
    }
    if let Some(limit) = budget.budget_daily {
        if let Some(msg) = check(86_400_000, limit, "Daily")? {
            return Ok(Some(msg));
        }
    }
    if let Some(limit) = budget.budget_weekly {
        if let Some(msg) = check(604_800_000, limit, "Weekly")? {
            return Ok(Some(msg));
        }
    }
    if let Some(limit) = budget.budget_monthly {
        if let Some(msg) = check(2_592_000_000, limit, "Monthly")? {
            return Ok(Some(msg));
        }
    }

    Ok(None)
}
