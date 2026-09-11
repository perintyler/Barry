//! Rendering (the Elm "view" half). Pure function of App state.
use crate::app::{App, Pane};
use crate::net::Delegation;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Frame;

fn color(name: &str) -> Color {
    match name {
        "cyan" => Color::Cyan,
        "green" => Color::Green,
        "yellow" => Color::Yellow,
        "red" => Color::Red,
        "magenta" => Color::Magenta,
        "blue" => Color::Blue,
        _ => Color::White,
    }
}

fn state_style(app: &App, state: &str) -> Style {
    let theme = &app.config.theme;
    match state {
        "merged" | "accepted" => Style::default().fg(color(&theme.ok)),
        "blocked" | "failed" | "cancelled" => Style::default().fg(color(&theme.err)),
        "running" | "verifying" | "integrating" => Style::default().fg(color(&theme.warn)),
        _ => Style::default(),
    }
}

pub fn draw(frame: &mut Frame, app: &App) {
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(3), Constraint::Length(1)])
        .split(frame.area());

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(app.config.layout.board_width_pct.min(80)),
            Constraint::Min(20),
        ])
        .split(outer[0]);

    draw_board(frame, app, main[0]);
    if app.pane == Pane::Evidence {
        draw_evidence(frame, app, main[1]);
    } else {
        draw_chat(frame, app, main[1]);
    }
    draw_input(frame, app, outer[1]);
    draw_status(frame, app, outer[2]);
}

fn draw_board(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.pane == Pane::Board;
    let items: Vec<ListItem> = app
        .delegations
        .iter()
        .enumerate()
        .map(|(index, delegation): (usize, &Delegation)| {
            let marker = if index == app.selected && focused { "▶ " } else { "  " };
            let line = Line::from(vec![
                Span::raw(marker),
                Span::styled(format!("[{}] ", delegation.state), state_style(app, &delegation.state)),
                Span::raw(format!("{} a{}", &delegation.id[..delegation.id.len().min(12)], delegation.attempts)),
            ]);
            let mut item = vec![line];
            if let Some(reason) = &delegation.reason {
                if index == app.selected {
                    item.push(Line::from(Span::styled(
                        format!("    {}", reason.chars().take(60).collect::<String>()),
                        Style::default().add_modifier(Modifier::DIM),
                    )));
                }
            }
            ListItem::new(item)
        })
        .collect();
    let title = format!(" task board ({}) ", app.delegations.len());
    let border = if focused {
        Style::default().fg(color(&app.config.theme.accent))
    } else {
        Style::default()
    };
    frame.render_widget(
        List::new(items).block(Block::default().borders(Borders::ALL).title(title).border_style(border)),
        area,
    );
}

fn draw_chat(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.pane == Pane::Chat;
    let mut lines: Vec<Line> = Vec::new();
    let visible = area.height.saturating_sub(2) as usize;
    for (role, content) in app.chat.iter().rev().take(visible * 2).rev() {
        let style = match role.as_str() {
            "you" | "user" => Style::default().fg(color(&app.config.theme.accent)),
            "error" => Style::default().fg(color(&app.config.theme.err)),
            "question" => Style::default().fg(color(&app.config.theme.warn)),
            _ => Style::default(),
        };
        for (i, part) in content.lines().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(format!("{role}› "), style.add_modifier(Modifier::BOLD)),
                    Span::raw(part.to_string()),
                ]));
            } else {
                lines.push(Line::from(Span::raw(format!("   {part}"))));
            }
        }
    }
    let border = if focused {
        Style::default().fg(color(&app.config.theme.accent))
    } else {
        Style::default()
    };
    let scroll = lines.len().saturating_sub(visible) as u16;
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0))
            .block(Block::default().borders(Borders::ALL).title(" point-guard ").border_style(border)),
        area,
    );
}

fn draw_evidence(frame: &mut Frame, app: &App, area: Rect) {
    let (id, text) = app.evidence.as_ref().map(|(a, b)| (a.as_str(), b.as_str())).unwrap_or(("", "(none)"));
    frame.render_widget(
        Paragraph::new(text)
            .wrap(Wrap { trim: false })
            .scroll((app.evidence_scroll, 0))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" evidence: {id} (esc to close) "))
                    .border_style(Style::default().fg(color(&app.config.theme.accent))),
            ),
        area,
    );
}

fn draw_input(frame: &mut Frame, app: &App, area: Rect) {
    let prompt = if app.sending { "sending… " } else { "› " };
    frame.render_widget(
        Paragraph::new(format!("{prompt}{}", app.input))
            .block(Block::default().borders(Borders::ALL).title(" message (enter to send, tab to switch, esc/q quit) ")),
        area,
    );
}

fn draw_status(frame: &mut Frame, app: &App, area: Rect) {
    let connection = if app.connected { "●" } else { "○" };
    let connection_style = if app.connected {
        Style::default().fg(color(&app.config.theme.ok))
    } else {
        Style::default().fg(color(&app.config.theme.err))
    };
    let mut spans = vec![
        Span::styled(connection.to_string(), connection_style),
        Span::raw(format!(" {} | cursor {}", app.status, app.last_cursor)),
    ];
    if let Some(error) = &app.config_error {
        spans.push(Span::styled(format!(" | {error}"), Style::default().fg(color(&app.config.theme.warn))));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}
