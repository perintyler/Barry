//! App state and update logic (the Elm "model + update" half). Rendering
//! never mutates; network work never blocks the render loop.
use crate::config::TuiConfig;
use crate::net::{ChatMessage, Delegation, NetEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Board,
    Chat,
    Evidence,
}

pub struct App {
    pub config: TuiConfig,
    pub config_error: Option<String>,
    pub connected: bool,
    pub status: String,
    pub pane: Pane,
    pub chat: Vec<(String, String)>, // (role, content)
    pub input: String,
    /// Unsent input survives reconnects; only an acknowledged send clears it.
    pub sending: bool,
    pub delegations: Vec<Delegation>,
    pub selected: usize,
    pub evidence: Option<(String, String)>, // (delegation id, text)
    pub evidence_scroll: u16,
    pub last_cursor: i64,
    pub should_quit: bool,
    pub needs_refresh: bool,
    pub pending_evidence: Option<String>,
    pub pending_merge: Option<String>,
    pub pending_cancel: Option<String>,
    pub pending_send: Option<String>,
}

impl App {
    pub fn new(config: TuiConfig, config_error: Option<String>) -> Self {
        Self {
            config,
            config_error,
            connected: false,
            status: "connecting…".into(),
            pane: Pane::Chat,
            chat: Vec::new(),
            input: String::new(),
            sending: false,
            delegations: Vec::new(),
            selected: 0,
            evidence: None,
            evidence_scroll: 0,
            last_cursor: 0,
            should_quit: false,
            needs_refresh: true,
            pending_evidence: None,
            pending_merge: None,
            pending_cancel: None,
            pending_send: None,
        }
    }

    pub fn on_net(&mut self, event: NetEvent) {
        match event {
            NetEvent::Connected => {
                self.connected = true;
                self.status = "connected".into();
                self.needs_refresh = true;
            }
            NetEvent::Disconnected(reason) => {
                self.connected = false;
                self.status = reason;
            }
            NetEvent::Stream { cursor, kind, payload } => {
                self.last_cursor = cursor;
                match kind.as_str() {
                    "chat.message" => self.needs_refresh = true,
                    "delegation.created" | "delegation.state" | "delegation.accepted" | "delegation.merged"
                    | "attempt.finished" | "merge.enqueued" => {
                        self.needs_refresh = true;
                        if kind == "delegation.merged" {
                            if let Some(id) = payload.get("delegationId").and_then(|v| v.as_str()) {
                                self.status = format!("merged: {id}");
                            }
                        }
                    }
                    "question.asked" => {
                        if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                            self.chat.push(("question".into(), text.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            NetEvent::ChatReply(reply) => {
                self.sending = false;
                self.chat.push(("pg".into(), reply));
            }
            NetEvent::ChatError(error) => {
                self.sending = false;
                self.chat.push(("error".into(), error));
            }
            NetEvent::Delegations(delegations) => {
                self.delegations = delegations;
                if self.selected >= self.delegations.len() && !self.delegations.is_empty() {
                    self.selected = self.delegations.len() - 1;
                }
            }
            NetEvent::History(messages) => {
                self.chat = messages
                    .into_iter()
                    .map(|m: ChatMessage| (m.role, m.content))
                    .collect();
            }
            NetEvent::Evidence { delegation_id, text } => {
                self.evidence = Some((delegation_id, text));
                self.evidence_scroll = 0;
                self.pane = Pane::Evidence;
            }
            NetEvent::Info(message) => {
                self.status = message;
                self.needs_refresh = true;
            }
        }
    }

    pub fn selected_delegation(&self) -> Option<&Delegation> {
        self.delegations.get(self.selected)
    }

    pub fn on_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        // Global chords first.
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        match self.pane {
            Pane::Chat => match key.code {
                KeyCode::Enter => {
                    let text = self.input.trim().to_string();
                    if !text.is_empty() && !self.sending {
                        self.chat.push(("you".into(), text.clone()));
                        self.pending_send = Some(text);
                        self.sending = true;
                        self.input.clear();
                    }
                }
                KeyCode::Backspace => {
                    self.input.pop();
                }
                KeyCode::Tab => self.pane = Pane::Board,
                KeyCode::Esc => self.should_quit = true,
                KeyCode::Char(c) => self.input.push(c),
                _ => {}
            },
            Pane::Board => {
                let keys = self.config.keys.clone();
                match key.code {
                    KeyCode::Tab => self.pane = Pane::Chat,
                    KeyCode::Esc => self.pane = Pane::Chat,
                    KeyCode::Up => self.selected = self.selected.saturating_sub(1),
                    KeyCode::Down => {
                        if self.selected + 1 < self.delegations.len() {
                            self.selected += 1;
                        }
                    }
                    KeyCode::Enter => {
                        if let Some(delegation) = self.selected_delegation() {
                            self.pending_evidence = Some(delegation.id.clone());
                        }
                    }
                    KeyCode::Char(c) if c == keys.quit => self.should_quit = true,
                    KeyCode::Char(c) if c == keys.scroll_up => self.selected = self.selected.saturating_sub(1),
                    KeyCode::Char(c) if c == keys.scroll_down => {
                        if self.selected + 1 < self.delegations.len() {
                            self.selected += 1;
                        }
                    }
                    KeyCode::Char(c) if c == keys.confirm_merge => {
                        if let Some(delegation) = self.selected_delegation() {
                            if delegation.state == "accepted" {
                                self.pending_merge = Some(delegation.id.clone());
                            } else {
                                self.status = format!("{} is {}, not accepted", delegation.id, delegation.state);
                            }
                        }
                    }
                    KeyCode::Char(c) if c == keys.cancel_delegation => {
                        if let Some(delegation) = self.selected_delegation() {
                            self.pending_cancel = Some(delegation.id.clone());
                        }
                    }
                    _ => {}
                }
            }
            Pane::Evidence => match key.code {
                KeyCode::Esc | KeyCode::Tab => self.pane = Pane::Board,
                KeyCode::Up => self.evidence_scroll = self.evidence_scroll.saturating_sub(3),
                KeyCode::Down => self.evidence_scroll = self.evidence_scroll.saturating_add(3),
                KeyCode::PageUp => self.evidence_scroll = self.evidence_scroll.saturating_sub(20),
                KeyCode::PageDown => self.evidence_scroll = self.evidence_scroll.saturating_add(20),
                KeyCode::Char(c) if c == self.config.keys.quit => self.should_quit = true,
                _ => {}
            },
        }
    }
}
