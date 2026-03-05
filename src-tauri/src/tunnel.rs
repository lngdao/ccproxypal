use anyhow::{anyhow, Result};
use regex::Regex;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::thread;

/// Check if cloudflared is available in PATH
pub fn is_cloudflared_available() -> bool {
    Command::new("cloudflared")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Start a cloudflared tunnel pointing to the proxy port.
/// Returns a child process handle. Calls `on_url` when the tunnel URL is ready.
pub fn start_tunnel<F>(port: u16, on_url: F) -> Result<Child>
where
    F: Fn(String) + Send + 'static,
{
    if !is_cloudflared_available() {
        return Err(anyhow!(
            "cloudflared not found. Install it with: brew install cloudflared"
        ));
    }

    let mut child = Command::new("cloudflared")
        .args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        // Discard stdout — cloudflared writes logs to stderr only.
        // Piping and not reading would block the process when the buffer fills.
        .stdout(Stdio::null())
        // Pipe stderr so we can extract the tunnel URL from it.
        .stderr(Stdio::piped())
        .spawn()?;

    let stderr = child.stderr.take().ok_or_else(|| anyhow!("No stderr"))?;

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let url_re = Regex::new(r"https://[a-z0-9\-]+\.trycloudflare\.com").unwrap();
        let mut url_found = false;

        // Keep reading ALL lines — stopping early causes the pipe buffer to fill,
        // which blocks cloudflared and eventually kills the process.
        for line in reader.lines() {
            if let Ok(line) = line {
                if !url_found {
                    if let Some(m) = url_re.find(&line) {
                        on_url(m.as_str().to_string());
                        url_found = true;
                        // Do NOT break — continue draining stderr forever.
                    }
                }
                // Optionally log: eprintln!("[cloudflared] {}", line);
            }
        }
        // Loop ends only when cloudflared exits (pipe closed).
    });

    Ok(child)
}

/// Kill a running tunnel process
pub fn stop_tunnel(child: &mut Child) -> Result<()> {
    child.kill().map_err(|e| anyhow!("Failed to kill cloudflared: {}", e))?;
    let _ = child.wait();
    Ok(())
}
