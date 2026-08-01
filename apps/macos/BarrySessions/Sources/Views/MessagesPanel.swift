import SwiftUI
import Components
import BarrySessionsCore

struct MessagesPanel: View {
    @Bindable var state: MessagesState
    var scrollToSequence: Int?

    @State private var expandedTools: Set<UUID> = []
    @State private var highlightedSequence: Int?
    @State private var position: ScrollPosition
    @State private var scroll: ChatScrollModel

    init(state: MessagesState, scrollToSequence: Int? = nil) {
        self.state = state
        self.scrollToSequence = scrollToSequence
        // Segments already exist: SessionDetailView only mounts this panel after
        // the initial load completes (see its `messagesContent`). So the deep-link
        // target id is resolvable at init — no post-hoc timed scrollTo needed.
        if let seq = scrollToSequence,
           let id = segmentId(containing: seq, in: state.segments) {
            _position = State(initialValue: ScrollPosition(id: id, anchor: .center))
            _scroll = State(initialValue: ChatScrollModel(followMode: false))
        } else {
            _position = State(initialValue: ScrollPosition(edge: .bottom))
            _scroll = State(initialValue: ChatScrollModel(followMode: true))
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(state.segments) { rendered in
                    if let pill = rendered.timestampPill {
                        timestampPill(pill)
                    }

                    switch rendered.segment {
                    case .turn(let turn):
                        turnView(turn)
                            .id(rendered.id)
                            .background(highlightBackground(forTurnContaining: turn))
                            .accessibilityIdentifier(rendered.id)
                    case .toolRow(let msg):
                        toolCallRow(msg)
                            .id(rendered.id)
                            .padding(.horizontal, 12)
                            .padding(.top, rendered.prevIsTurn ? 6 : 2)
                            .padding(.bottom, rendered.nextIsTurn ? 6 : 2)
                            .background(highlightBackground(forSequence: msg.sequence))
                            .accessibilityIdentifier(rendered.id)
                    }
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 12)
            .scrollTargetLayout()
        }
        .accessibilityIdentifier("MessageScrollView")
        // Loading spinners are overlays, NOT list content — if they lived inside
        // the LazyVStack they'd change contentHeight on load and corrupt the
        // prepend-compensation delta (and shift the viewport when they vanish).
        .overlay(alignment: .top) {
            loadingIndicator(visible: state.hasOlder && state.isLoadingOlder)
        }
        .overlay(alignment: .bottom) {
            loadingIndicator(visible: state.hasNewer && state.isLoadingNewer)
        }
        .scrollPosition($position)
        // Initial anchor: bottom for a normal open, centered target for a deep-link.
        .defaultScrollAnchor(scrollToSequence == nil ? .bottom : .center, for: .initialOffset)
        // While following, pin the bottom through content-size growth (poll appends,
        // markdown reflow, tool-detail loads) atomically at layout time.
        .defaultScrollAnchor(scroll.followMode ? .bottom : nil, for: .sizeChanges)
        .onScrollGeometryChange(for: ChatScrollModel.Metrics.self) { geo in
            ChatScrollModel.Metrics(
                offsetY: geo.contentOffset.y + geo.contentInsets.top,
                contentHeight: geo.contentSize.height,
                viewportHeight: geo.containerSize.height
            )
        } action: { _, metrics in
            handleGeometry(metrics)
        }
        .onScrollPhaseChange { _, phase in
            let interacting = phase == .interacting || phase == .decelerating
            scroll.phaseDidChange(isInteracting: interacting)
        }
        .onChange(of: state.mutationGeneration) {
            handleMutation()
        }
        .overlay(alignment: .bottom) {
            newMessagesPill
        }
        .task {
            // Deep-link: highlight the target briefly, then fade. Scroll position
            // is set by the ScrollPosition initializer, so no scrollTo here.
            guard let target = scrollToSequence else { return }
            highlightedSequence = target
            try? await Task.sleep(for: .seconds(1.5))
            withAnimation(.easeOut(duration: 0.5)) {
                highlightedSequence = nil
            }
        }
    }

    // MARK: - Scroll handling

    private func handleGeometry(_ metrics: ChatScrollModel.Metrics) {
        // Prepend compensation lands first; restore the exact pre-insert offset.
        if let targetY = scroll.geometryDidChange(metrics) {
            position.scrollTo(y: targetY)
            return
        }
        guard !scroll.isAdjusting else { return }

        // Pagination triggers (guarded against re-fire during loads/initial layout).
        if scroll.shouldLoadOlder, state.hasOlder, !state.isLoadingOlder, !state.isLoadingInitial {
            // Snapshot the pre-insert geometry now, before any intervening callback.
            scroll.prependBaseline = metrics
            Task { await state.loadOlder() }
        }
        if scroll.shouldLoadNewer, state.hasNewer, !state.isLoadingNewer {
            Task { await state.loadNewer() }
        }
    }

    private func handleMutation() {
        switch state.lastMutation {
        case .prepend:
            // Use the geometry snapshot taken when loadOlder was triggered (see
            // handleGeometry), so the next geometry callback restores the exact
            // pre-insert pixel offset once the inserted rows have measured.
            if let m = scroll.prependBaseline ?? scroll.lastMetrics {
                scroll.pendingCompensation = .init(savedOffset: m.offsetY, savedHeight: m.contentHeight)
                scroll.prependBaseline = nil
            }
        case .append(let count):
            if scroll.followMode {
                // The `.sizeChanges` bottom anchor should keep us pinned at layout
                // time. Re-pin explicitly as a belt-and-suspenders: if the anchor
                // already worked we're at the bottom and this is a no-op; if it
                // didn't, this corrects it. Safe against follow-break — a
                // programmatic scroll never reports an `.interacting` phase, so it
                // can't disengage follow-mode.
                position.scrollTo(edge: .bottom)
            } else {
                scroll.didAppendWhileScrolledUp(count: count)
            }
        case .initial:
            scroll.reset(followMode: scrollToSequence == nil)
            if scrollToSequence == nil {
                position.scrollTo(edge: .bottom)
            }
        case .detailUpdate:
            break
        }
    }

    // MARK: - New-messages pill

    @ViewBuilder
    private var newMessagesPill: some View {
        if scroll.unseenCount > 0 && !scroll.followMode {
            Button {
                scroll.unseenCount = 0
                scroll.followMode = true
                withAnimation(.easeOut(duration: 0.25)) {
                    position.scrollTo(edge: .bottom)
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 9, weight: .semibold))
                    Text("\(scroll.unseenCount) new message\(scroll.unseenCount == 1 ? "" : "s")")
                        .font(AppFont.sans(size: 11, weight: .medium))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.primary.opacity(0.08), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 14)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityIdentifier("NewMessagesPill")
        }
    }

    // MARK: - Loading indicator

    @ViewBuilder
    private func loadingIndicator(visible: Bool) -> some View {
        if visible {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading…")
                    .font(AppFont.sans(size: 11))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .padding(.vertical, 8)
            .transition(.opacity)
            .allowsHitTesting(false)
        }
    }

    /// Highlight background for a tool row.
    private func highlightBackground(forSequence seq: Int) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(Color.yellow.opacity(highlightedSequence == seq ? 0.15 : 0))
    }

    /// Highlight background for a turn if it contains the highlighted sequence.
    private func highlightBackground(forTurnContaining turn: Turn) -> some View {
        let isHighlighted = highlightedSequence != nil && turn.messages.contains { $0.sequence == highlightedSequence }
        return RoundedRectangle(cornerRadius: 6)
            .fill(Color.yellow.opacity(isHighlighted ? 0.15 : 0))
    }

    // MARK: - Turn Colors

    private enum TurnColors {
        // Base hues per appearance: 400-tier on dark, 600-tier on light
        static let userBase = Color.adaptive(
            light: Color(red: 37/255, green: 99/255, blue: 235/255),    // #2563eb
            dark: Color(red: 96/255, green: 165/255, blue: 250/255)     // #60a5fa
        )
        static let userBg = userBase.opacity(0.055)
        static let userLine = userBase.opacity(0.16)
        static let userLabel = userBase.opacity(0.55)

        static let agentBase = Color.adaptive(
            light: Color(red: 217/255, green: 119/255, blue: 6/255),    // #d97706
            dark: Color(red: 251/255, green: 191/255, blue: 36/255)     // #fbbf24
        )
        static let agentBg = agentBase.opacity(0.04)
        static let agentLine = agentBase.opacity(0.1)
        static let agentLabel = agentBase.opacity(0.45)
    }

    // MARK: - Turn View

    @ViewBuilder
    private func turnView(_ turn: Turn) -> some View {
        let isUser = turn.speaker == .user
        let bg = isUser ? TurnColors.userBg : TurnColors.agentBg
        let lineColor = isUser ? TurnColors.userLine : TurnColors.agentLine
        let labelColor = isUser ? TurnColors.userLabel : TurnColors.agentLabel
        let label = isUser ? "You" : "Barry"

        VStack(alignment: .leading, spacing: 0) {
            TurnSeparator(label: label, lineColor: lineColor, labelColor: labelColor)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)

            ForEach(turn.messages) { msg in
                turnMessageRow(msg)
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(bg)
    }

    // MARK: - Message Routing

    @ViewBuilder
    private func turnMessageRow(_ msg: Message) -> some View {
        switch msg.type {
        case "text":
            if msg.isUser, let content = msg.content, let skill = Self.parseSkillInvocation(content) {
                skillInvocationRow(skillName: skill.name, args: skill.args)
                    .padding(.horizontal, 24)
            } else {
                EquatableView(content: MarkdownText(content: msg.content ?? ""))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }
        case "error":
            errorRow(msg)
                .padding(.horizontal, 24)
        default:
            systemRow(msg)
                .padding(.horizontal, 24)
        }
    }

    // MARK: - Skill Invocation

    private struct SkillInvocation {
        let name: String
        let args: String?
    }

    /// Detect `/skill-name` or `/pack:skill-name` at the start of a user message.
    /// Returns the skill name and any trailing arguments.
    /// Rejects file paths like `/usr/bin/foo` and URLs — the char after the
    /// skill name must be whitespace or end-of-string, never `/`.
    private static func parseSkillInvocation(_ content: String) -> SkillInvocation? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }

        // Match /word or /word:word (pack:skill format), followed by optional args
        let scanner = Scanner(string: trimmed)
        _ = scanner.scanString("/")

        // Skill name: word chars, colons, hyphens
        var nameChars = CharacterSet.alphanumerics
        nameChars.insert(charactersIn: ":-_")
        guard let name = scanner.scanCharacters(from: nameChars), !name.isEmpty else { return nil }

        // Reject file paths: if the next char is `/`, this is a path not a skill
        let rest = trimmed[scanner.currentIndex...]
        if rest.first == "/" { return nil }

        // Reject names that are just numbers (e.g. user typed a fraction)
        if name.allSatisfy(\.isNumber) { return nil }

        // Rest is args (if any)
        let remaining = String(rest).trimmingCharacters(in: .whitespaces)
        let args = remaining.isEmpty ? nil : remaining

        return SkillInvocation(name: name, args: args)
    }

    private static let skillPurple = Color.adaptive(
        light: Color(red: 0.49, green: 0.23, blue: 0.93),               // #7c3aed
        dark: Color(red: 0.65, green: 0.45, blue: 0.95)
    )

    // Tool row dimness levels, mirrored per appearance
    private static let toolName = Color.adaptive(light: Color(white: 0.60), dark: Color(white: 0.33))
    private static let toolSummary = Color.adaptive(
        light: Color(red: 0.72, green: 0.73, blue: 0.75),
        dark: Color(red: 0.22, green: 0.23, blue: 0.25)                 // #383b40
    )
    private static let toolHairline = Color.primary.opacity(0.05)
    private static let toolChevron = Color.adaptive(light: Color(white: 0.80), dark: Color(white: 0.2))

    private func skillInvocationRow(skillName: String, args: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Self.skillPurple)

                Text("/\(skillName)")
                    .font(AppFont.mono(size: 11.5, weight: .semibold))
                    .foregroundStyle(Self.skillPurple)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Self.skillPurple.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Self.skillPurple.opacity(0.15), lineWidth: 1)
            )

            if let args, !args.isEmpty {
                EquatableView(content: MarkdownText(content: args))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Tool Call Row (Style 7a)

    private func toolCallRow(_ msg: Message) -> some View {
        let isExpanded = expandedTools.contains(msg.id)

        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    if isExpanded {
                        expandedTools.remove(msg.id)
                    } else {
                        expandedTools.insert(msg.id)
                        if msg.needsDetailLoad {
                            Task { await state.loadDetail(for: msg.sequence) }
                        }
                    }
                }
                // Expansion grows the row downward in place (standard macOS
                // disclosure); the clicked row stays put — no scroll hack needed.
            } label: {
                HStack(spacing: 8) {
                    Text(msg.name ?? "unknown")
                        .font(AppFont.mono(size: 10.5, weight: .semibold))
                        .foregroundStyle(Self.toolName)
                        .fixedSize()

                    Text(msg.toolInputSummary)
                        .font(AppFont.sans(size: 10.5))
                        .foregroundStyle(Self.toolSummary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Rectangle()
                        .fill(Self.toolHairline)
                        .frame(height: 1)

                    Text("\u{203A}")
                        .font(AppFont.sans(size: 9))
                        .foregroundStyle(Self.toolChevron)
                        .fixedSize()
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Expanded detail
            if isExpanded {
                if msg.needsDetailLoad {
                    if state.loadingDetails.contains(msg.sequence) {
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Loading\u{2026}")
                                .font(AppFont.sans(size: 10))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.leading, 12)
                        .padding(.vertical, 6)
                        .transition(.opacity)
                    }
                } else {
                    toolDetailView(
                        name: msg.name ?? "unknown",
                        input: ToolInput(msg.input),
                        result: msg.result
                    )
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    // MARK: - Error Row

    private func errorRow(_ msg: Message) -> some View {
        HStack {
            Text(msg.error ?? msg.content ?? "Error")
                .font(AppFont.sans(size: 12))
                .foregroundStyle(.red)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color.red.opacity(0.15), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 6))
            Spacer()
        }
        .padding(.vertical, 6)
    }

    // MARK: - System Row

    private func systemRow(_ msg: Message) -> some View {
        HStack {
            Spacer()
            Text(msg.result ?? msg.content ?? "")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Spacer()
        }
        .padding(.vertical, 6)
    }

    // MARK: - Timestamp Pill

    private func timestampPill(_ text: String) -> some View {
        HStack {
            Spacer()
            Text(text)
                .font(AppFont.sans(size: 10, weight: .medium))
                .foregroundStyle(Self.toolName)
                .padding(.vertical, 3)
                .padding(.horizontal, 14)
                .background(Color.primary.opacity(0.035))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Spacer()
        }
        .padding(.vertical, 4)
    }
}
