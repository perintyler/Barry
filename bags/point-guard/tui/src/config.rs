//! TUI configuration: ~/.barry/tui.toml with validated hot reload.
//! A broken edit keeps the last-good config — a typo must never take the
//! board down mid-run.
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TuiConfig {
    pub keys: Keys,
    pub theme: Theme,
    pub layout: Layout,
    /// Delegation list refresh interval (ms) as a fallback for missed events.
    pub refresh_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Keys {
    pub quit: char,
    pub next_pane: char,
    pub confirm_merge: char,
    pub cancel_delegation: char,
    pub scroll_up: char,
    pub scroll_down: char,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Theme {
    pub accent: String,
    pub ok: String,
    pub warn: String,
    pub err: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Layout {
    pub board_width_pct: u16,
    pub show_ledger: bool,
}

impl Default for TuiConfig {
    fn default() -> Self {
        Self { keys: Keys::default(), theme: Theme::default(), layout: Layout::default(), refresh_ms: 15_000 }
    }
}
impl Default for Keys {
    fn default() -> Self {
        Self { quit: 'q', next_pane: '\t', confirm_merge: 'm', cancel_delegation: 'x', scroll_up: 'k', scroll_down: 'j' }
    }
}
impl Default for Theme {
    fn default() -> Self {
        Self { accent: "cyan".into(), ok: "green".into(), warn: "yellow".into(), err: "red".into() }
    }
}
impl Default for Layout {
    fn default() -> Self {
        Self { board_width_pct: 38, show_ledger: true }
    }
}

pub fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".barry").join("tui.toml")
}

/// Load or fall back. Returns (config, Option<error string>) so the caller
/// can surface a bad file without dying on it.
pub fn load() -> (TuiConfig, Option<String>) {
    match std::fs::read_to_string(config_path()) {
        Ok(text) => match toml::from_str::<TuiConfig>(&text) {
            Ok(config) => (config, None),
            Err(error) => (TuiConfig::default(), Some(format!("tui.toml invalid: {error}"))),
        },
        Err(_) => (TuiConfig::default(), None), // absent file is the normal case
    }
}
