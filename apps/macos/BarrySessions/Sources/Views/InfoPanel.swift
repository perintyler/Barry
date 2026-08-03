import SwiftUI
import BarryKit

struct InfoPanel: View {
    let session: Session
    let messagesState: MessagesState
    let onSessionUpdated: () -> Void

    @State private var editingName: String = ""
    @State private var isReadOnly: Bool = false
    @State private var isPinned: Bool = false
    @State private var selectedModel: String = ""
    @State private var modelCatalog: [String: ProviderModels] = [:]
    @State private var profileDefaults: [ProfileDefaults] = []
    @State private var showStopConfirm = false
    @State private var errorMessage: String?

    private let client = BarryClient()

    /// What the session inherits when no explicit model is set: the profile's
    /// default_model (when the session runs the profile's own provider),
    /// otherwise the catalog default for the provider.
    private var inheritedModelLabel: String {
        let provider = session.provider ?? "claude"
        if let pid = session.profileId,
           let profile = profileDefaults.first(where: { $0.id == pid }),
           (profile.defaultCodingAgent ?? "claude") == provider,
           let model = profile.defaultModel {
            return "Default — \(model)"
        }
        if let fallback = modelCatalog[provider]?.default {
            return "Default — \(fallback)"
        }
        return "Default"
    }

    /// Catalog models for this session's provider, with an off-catalog current
    /// value kept selectable so it never silently disappears.
    private var modelOptions: [ModelInfo] {
        let provider = session.provider ?? "claude"
        var options = modelCatalog[provider]?.models.map {
            ModelInfo(id: $0.id, label: "\($0.label) — \($0.id)")
        } ?? []
        if !selectedModel.isEmpty, !options.contains(where: { $0.id == selectedModel }) {
            options.append(ModelInfo(id: selectedModel, label: "\(selectedModel) (custom)"))
        }
        return options
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Name (editable)
                infoField("Name") {
                    TextField("Session name", text: $editingName)
                        .textFieldStyle(.plain)
                        .font(AppFont.sans(size: 13))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.quaternary.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .onSubmit { commitRename() }
                }

                // ID
                infoField("ID") {
                    Text(session.id)
                        .font(AppFont.mono(size: 11))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                // Status
                infoField("Status") {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 7, height: 7)
                        Text(session.status.capitalized)
                            .font(AppFont.sans(size: 13))
                    }
                }

                // Repository
                if let path = session.repoPath, !path.isEmpty {
                    infoField("Repository") {
                        Text(session.displayPath)
                            .font(AppFont.mono(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }

                // Source
                if let source = session.source {
                    infoField("Source") {
                        Text(source)
                            .font(AppFont.sans(size: 13))
                    }
                }

                // Created
                if let created = session.createdAt {
                    infoField("Created") {
                        Text(formattedTime(created))
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }

                // Last Msg
                infoField("Last Msg") {
                    if let date = messagesState.lastMessageDate {
                        Text(formattedTimeFromDate(date))
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.secondary)
                    } else {
                        Text(messagesState.isLoadingInitial ? "Loading..." : "No messages")
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.tertiary)
                    }
                }

                // Linear / GitHub badges
                if session.linearTicket != nil || session.githubPr != nil {
                    infoField("Links") {
                        HStack(spacing: 6) {
                            if let ticket = session.linearTicket {
                                Badge(text: ticket, style: .linear)
                            }
                            if let pr = session.githubPr {
                                Badge(text: "PR #\(pr)", style: .github)
                            }
                        }
                    }
                }

                // Divider
                Divider()
                    .padding(.vertical, 6)

                // Read-Only toggle
                infoField("Read-Only") {
                    HStack {
                        Text("Disable write tools")
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Toggle("", isOn: $isReadOnly)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .onChange(of: isReadOnly) { _, newValue in
                                commitReadOnly(newValue)
                            }
                    }
                }

                // Pinned toggle
                infoField("Pinned") {
                    HStack {
                        Text("Keep in session list")
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Toggle("", isOn: $isPinned)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .onChange(of: isPinned) { _, newValue in
                                commitPinned(newValue)
                            }
                    }
                }

                // Model picker — applies on next start/resume
                infoField("Model") {
                    HStack {
                        Picker("", selection: $selectedModel) {
                            Text(inheritedModelLabel).tag("")
                            ForEach(modelOptions, id: \.id) { model in
                                Text(model.label).tag(model.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .fixedSize()
                        .onChange(of: selectedModel) { _, newValue in
                            commitModel(newValue)
                        }
                        Spacer()
                        Text("Next start/resume")
                            .font(AppFont.sans(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                }

                // Error display
                if let err = errorMessage {
                    Text(err)
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }

                // Stop button (running only)
                if session.isRunning {
                    Button {
                        showStopConfirm = true
                    } label: {
                        Text("Stop Session")
                            .font(AppFont.sans(size: 12, weight: .medium))
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.red.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .alert("Stop Session", isPresented: $showStopConfirm) {
                        Button("Cancel", role: .cancel) {}
                        Button("Stop", role: .destructive) { commitStop() }
                    } message: {
                        Text("This will stop the running session. This action cannot be undone.")
                    }
                }

                Spacer(minLength: 16)
            }
        }
        .onAppear {
            editingName = session.name
            isReadOnly = session.isReadOnly
            isPinned = session.pinned ?? false
            selectedModel = session.model ?? ""
        }
        .task {
            // Catalog + profile defaults are advisory — load best-effort
            if let catalog = try? await client.fetchModels() {
                modelCatalog = catalog
            }
            if let profiles = try? await client.fetchProfileDefaults() {
                profileDefaults = profiles
            }
        }
    }

    // MARK: - Layout

    private func infoField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 0) {
            Text(label)
                .font(AppFont.sans(size: 11, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 80, alignment: .leading)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .overlay(alignment: .bottom) {
            Divider().padding(.leading, 16)
        }
    }

    // MARK: - Actions

    private func commitRename() {
        let newName = editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !newName.isEmpty, newName != session.name else { return }
        Task {
            do {
                try await client.renameSession(sessionId: session.id, name: newName)
                onSessionUpdated()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func commitReadOnly(_ readOnly: Bool) {
        Task {
            do {
                let scope: [String: Any] = readOnly
                    ? ["deniedAccess": ["write"]]
                    : ["deniedAccess": [String]()]
                try await client.updateScope(sessionId: session.id, scope: scope)
                onSessionUpdated()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func commitPinned(_ pinned: Bool) {
        Task {
            do {
                try await client.updatePinned(sessionId: session.id, pinned: pinned)
                onSessionUpdated()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func commitModel(_ model: String) {
        // Skip the spurious change fired when onAppear seeds the picker
        guard model != (session.model ?? "") else { return }
        Task {
            do {
                try await client.setModel(sessionId: session.id, model: model.isEmpty ? nil : model)
                onSessionUpdated()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func commitStop() {
        Task {
            do {
                try await client.stopSession(sessionId: session.id)
                onSessionUpdated()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Helpers

    private var statusColor: Color {
        switch session.status {
        case "running": return .green
        case "pending": return .orange
        default: return .secondary
        }
    }

    private func formattedTime(_ iso: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = isoFormatter.date(from: iso) {
            return formattedTimeFromDate(date)
        }
        // Retry without fractional seconds
        isoFormatter.formatOptions = [.withInternetDateTime]
        if let date = isoFormatter.date(from: iso) {
            return formattedTimeFromDate(date)
        }
        return iso
    }

    private func formattedTimeFromDate(_ date: Date) -> String {
        let df = DateFormatter()
        df.dateStyle = .medium
        df.timeStyle = .short
        let absolute = df.string(from: date)

        let rf = RelativeDateTimeFormatter()
        rf.unitsStyle = .abbreviated
        let relative = rf.localizedString(for: date, relativeTo: Date())

        return "\(absolute) (\(relative))"
    }
}

// MARK: - Badge

private struct Badge: View {
    let text: String
    let style: BadgeStyle

    enum BadgeStyle {
        case linear, github
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: style == .linear ? "lineweight" : "arrow.triangle.pull")
                .font(AppFont.sans(size: 10))
            Text(text)
                .font(AppFont.sans(size: 11, weight: .medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(backgroundColor)
        .foregroundStyle(foregroundColor)
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private var foregroundColor: Color {
        switch style {
        case .linear: return Color(red: 0.55, green: 0.51, blue: 1.0)
        case .github: return .secondary
        }
    }

    private var backgroundColor: Color {
        foregroundColor.opacity(0.12)
    }
}
