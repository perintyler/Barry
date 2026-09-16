import AppKit
import Components
import SwiftUI

public struct EventsView: View {
    @ObservedObject var state: EventsState
    @State private var expandedID: String?

    public init(state: EventsState) {
        self.state = state
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if state.notificationsDenied {
                notificationsOffBanner
                Divider()
            }
            content
            Divider()
            footer
        }
        .background(Palette.windowBackground)
    }

    /// Notifications are granted per bundle identifier, and this app has a new
    /// one — so anybody who had allowed the old BarryEvents app is silently
    /// starting from scratch. Without this the only symptom is events quietly
    /// never announcing themselves again, which reads as a broken feed.
    private var notificationsOffBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "bell.slash")
                .font(.system(size: 10))
                .foregroundStyle(Palette.amber)
            Text("Notifications are off — events appear here only while open.")
                .font(AppFont.sans(size: 10))
                .foregroundStyle(.secondary)
            Spacer()
            Button("Open Settings") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") {
                    NSWorkspace.shared.open(url)
                }
            }
            .buttonStyle(.plain)
            .font(AppFont.sans(size: 10, weight: .medium))
            .foregroundStyle(Palette.blue)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Text("Events")
                .font(AppFont.sans(size: 13, weight: .semibold))

            if state.unreadCount > 0 {
                Text("\(state.unreadCount)")
                    .font(AppFont.sans(size: 10, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Palette.blue, in: Capsule())
            }

            Spacer()

            if state.unreadCount > 0 {
                Button(action: state.markAllRead) {
                    Text("Mark all read")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Mark every event as read")
            }

            Button(action: state.refresh) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Refresh")
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let error = state.errorMessage, state.events.isEmpty {
            emptyState(
                symbol: "exclamationmark.triangle",
                title: "Can't reach Barry",
                detail: error,
                tint: Palette.amber
            )
        } else if state.events.isEmpty && state.hasLoadedOnce {
            emptyState(
                symbol: "tray",
                title: "No events yet",
                detail: "Progress, notifications, and alerts land here.",
                tint: .secondary
            )
        } else if state.events.isEmpty {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            feed
        }
    }

    private var feed: some View {
        ScrollView {
            // LazyVStack, despite lazy containers animating a child's height
            // change less smoothly than an eager one: the eager version rested
            // on "paging keeps the count bounded", which is not true. `loadMore`
            // appends and `merge` preserves every page already held, so the feed
            // grows without limit and each row carries a GeometryReader whose
            // preference writes propagate across the whole tree on every
            // refresh. Bounded jank while one row expands beats unbounded work
            // on every layout pass.
            LazyVStack(spacing: 0) {
                ForEach(state.events) { event in
                    EventRow(
                        event: event,
                        isExpanded: expandedID == event.id,
                        onToggle: { toggle(event) },
                        onOpenSession: { state.open(event) },
                        onMarkRead: { state.markRead(event) }
                    )
                    Divider().opacity(0.5)
                }

                if state.hasMore {
                    // Appears only when scrolled to, which is what triggers the
                    // next page — no scroll-offset math needed.
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .onAppear { state.loadMore() }
                }
            }
        }
    }

    private func toggle(_ event: BarryEvent) {
        // A gentle spring settles without the overshoot wobble of a bouncier
        // curve, and reads better than a linear ease for a size change.
        withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
            expandedID = expandedID == event.id ? nil : event.id
        }
        // Opening an unread event counts as reading it.
        if expandedID == event.id { state.markRead(event) }
    }

    private func emptyState(symbol: String, title: String, detail: String, tint: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 26))
                .foregroundStyle(tint.opacity(0.7))
            Text(title)
                .font(AppFont.sans(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text(detail)
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            if let refreshed = state.lastRefresh {
                Text("Updated \(refreshed.formatted(date: .omitted, time: .shortened))")
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(.plain)
                .font(AppFont.sans(size: 10))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}
