//! point-guard TUI: a pure client of the point-guard service.
//! Event → update → render; network runs off the render loop; terminal is
//! restored on every exit path (ratatui's init installs the panic hook).
mod app;
mod config;
mod net;
mod ui;

use app::App;
use crossterm::event::{Event, EventStream, KeyEventKind};
use futures_util::StreamExt;
use net::{NetEvent, Service};
use std::time::Duration;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let (config, config_error) = config::load();
    let service = Service::from_env();
    if service.secret.is_empty() {
        eprintln!("BARRY_SECRET is not set; the service will refuse every request.");
        eprintln!("Run via the barry launcher or export BARRY_SECRET.");
        std::process::exit(2);
    }

    let mut terminal = ratatui::init();
    let result = run(&mut terminal, config, config_error, service).await;
    ratatui::restore();
    result
}

async fn run(
    terminal: &mut ratatui::DefaultTerminal,
    config: config::TuiConfig,
    config_error: Option<String>,
    service: Service,
) -> std::io::Result<()> {
    let mut app = App::new(config, config_error);
    let (tx, mut rx) = mpsc::unbounded_channel::<NetEvent>();

    // WS stream with replay-from-0 on first connect (the app dedups by cursor).
    tokio::spawn(net::ws_task(service.clone(), tx.clone(), 0));
    // Initial data.
    {
        let s = service.clone();
        let t = tx.clone();
        tokio::spawn(async move {
            s.fetch_history(t.clone()).await;
            s.fetch_delegations(t).await;
        });
    }

    // Config hot reload: watch the file; a broken edit keeps last-good.
    let (config_tx, mut config_rx) = mpsc::unbounded_channel::<()>();
    let _watcher = spawn_config_watcher(config_tx);

    let mut events = EventStream::new();
    let mut refresh = tokio::time::interval(Duration::from_millis(app.config.refresh_ms.max(2_000)));

    loop {
        // Drain any actions the last update queued (network off the render loop).
        if let Some(text) = app.pending_send.take() {
            let s = service.clone();
            let t = tx.clone();
            tokio::spawn(async move { s.send_chat(text, t).await });
        }
        if let Some(id) = app.pending_evidence.take() {
            let s = service.clone();
            let t = tx.clone();
            tokio::spawn(async move { s.fetch_evidence(id, t).await });
        }
        if let Some(id) = app.pending_merge.take() {
            let s = service.clone();
            let t = tx.clone();
            tokio::spawn(async move { s.confirm_merge(id, t).await });
        }
        if let Some(id) = app.pending_cancel.take() {
            let s = service.clone();
            let t = tx.clone();
            tokio::spawn(async move { s.cancel(id, t).await });
        }
        if app.needs_refresh {
            app.needs_refresh = false;
            let s = service.clone();
            let t = tx.clone();
            tokio::spawn(async move {
                s.fetch_delegations(t.clone()).await;
                s.fetch_history(t).await;
            });
        }

        terminal.draw(|frame| ui::draw(frame, &app))?;
        if app.should_quit {
            return Ok(());
        }

        tokio::select! {
            maybe_event = events.next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => app.on_key(key),
                    Some(Ok(Event::Resize(_, _))) => {} // next draw handles it
                    Some(Err(_)) | None => return Ok(()),
                    _ => {}
                }
            }
            Some(net_event) = rx.recv() => {
                app.on_net(net_event);
                // Coalesce a burst of stream events into one redraw pass.
                while let Ok(more) = rx.try_recv() { app.on_net(more); }
            }
            _ = refresh.tick() => { app.needs_refresh = true; }
            Some(_) = config_rx.recv() => {
                let (fresh, error) = config::load();
                match error {
                    Some(message) => app.config_error = Some(message), // keep last-good config
                    None => { app.config = fresh; app.config_error = None; }
                }
            }
        }
    }
}

fn spawn_config_watcher(tx: mpsc::UnboundedSender<()>) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let path = config::config_path();
    let parent = path.parent()?.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        if let Ok(event) = result {
            if event.paths.iter().any(|p| p.ends_with("tui.toml")) {
                let _ = tx.send(());
            }
        }
    })
    .ok()?;
    watcher.watch(&parent, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}
