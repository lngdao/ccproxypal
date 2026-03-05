use anyhow::{anyhow, Result};
use regex::Regex;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::thread;

/// macOS GUI apps launch with a minimal PATH that excludes Homebrew.
/// Use `which`/`where` for PATH lookup, then fall back to known install locations.
fn find_cloudflared() -> Option<String> {
    // First: ask the shell where the binary is (works in dev / terminal launches)
    #[cfg(unix)]
    if let Ok(out) = std::process::Command::new("which").arg("cloudflared").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    #[cfg(windows)]
    if let Ok(out) = std::process::Command::new("where").arg("cloudflared").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }

    // Fallback: check known install locations by file existence
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    let candidates: &[&str] = &[
        "/opt/homebrew/bin/cloudflared",                            // macOS Apple Silicon
        "/usr/local/bin/cloudflared",                               // macOS Intel / Linux
        "/usr/bin/cloudflared",                                     // Linux system
        "/usr/local/sbin/cloudflared",
        "/snap/bin/cloudflared",                                    // Linux Snap
        r"C:\Program Files\cloudflared\cloudflared.exe",            // Windows
        r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
    ];

    for &path in candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    // ~/.local/bin (Linux user install)
    let local_bin = format!("{}/.local/bin/cloudflared", home);
    if std::path::Path::new(&local_bin).exists() {
        return Some(local_bin);
    }

    None
}

/// Check if cloudflared is available
pub fn is_cloudflared_available() -> bool {
    find_cloudflared().is_some()
}

/// Start a cloudflared tunnel pointing to the proxy port.
/// Returns a child process handle. Calls `on_url` when the tunnel URL is ready.
pub fn start_tunnel<F>(port: u16, on_url: F) -> Result<Child>
where
    F: Fn(String) + Send + 'static,
{
    let bin = find_cloudflared().ok_or_else(|| {
        #[cfg(windows)]
        return anyhow!("cloudflared not found — download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
        #[cfg(not(windows))]
        return anyhow!("cloudflared not found — brew install cloudflared");
    })?;

    #[allow(unused_mut)]
    let mut cmd = Command::new(&bin);
    cmd.args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Prevent a console window from flashing on Windows
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;

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
