import BarryKit
import SwiftUI

struct NewSessionView: View {
    @Bindable var appState: AppState
    @Binding var isPresented: Bool

    @State private var prompt = ""
    @State private var repoPath = ""
    @State private var name = ""
    @State private var profileId: Int?
    @State private var provider = "claude"
    @State private var model = ""
    @State private var selectedTraits = Set<String>()
    @State private var useWorktree = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var canSubmit: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSubmitting
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("New Session").font(.title2.weight(.semibold))
                Spacer()
                Button("Cancel") { isPresented = false }
            }

            TextField("Repository path", text: $repoPath)
                .textFieldStyle(.roundedBorder)
            TextField("Session name (optional)", text: $name)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $prompt)
                .font(.body)
                .frame(minHeight: 130)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))

            Picker("Profile", selection: $profileId) {
                Text("Inherit — repository or global default").tag(Int?.none)
                ForEach(appState.profiles) { profile in
                    Text(profile.name).tag(Int?.some(profile.id))
                }
            }

            HStack {
                Picker("Provider", selection: $provider) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                    Text("OpenCode").tag("opencode")
                }
                TextField("Model override (optional)", text: $model)
                    .textFieldStyle(.roundedBorder)
            }

            if !appState.availableTraits.isEmpty {
                Text("Traits").font(.headline)
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(appState.availableTraits) { trait in
                            Toggle(trait.name, isOn: Binding(
                                get: { selectedTraits.contains(trait.name) },
                                set: { enabled in
                                    if enabled { selectedTraits.insert(trait.name) }
                                    else { selectedTraits.remove(trait.name) }
                                }
                            ))
                            .toggleStyle(.button)
                        }
                    }
                }
            }

            Toggle("Use worktree", isOn: $useWorktree)

            if let errorMessage {
                Text(errorMessage).foregroundStyle(.red).font(.caption)
            }

            Spacer()
            HStack {
                Spacer()
                Button(isSubmitting ? "Starting…" : "Start Session") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSubmit)
            }
        }
        .padding(20)
        .task { await appState.loadSessionCreationOptions() }
    }

    private func submit() {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                try await appState.createSession(
                    prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    repoPath: repoPath.trimmingCharacters(in: .whitespacesAndNewlines),
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    profileId: profileId,
                    traits: selectedTraits.sorted(),
                    provider: provider,
                    model: model.trimmingCharacters(in: .whitespacesAndNewlines),
                    useWorktree: useWorktree
                )
                isPresented = false
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}
