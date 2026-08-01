import SwiftUI

struct PacksPanel: View {
    @Bindable var editor: ProfileEditor

    var body: some View {
        FilterBar(text: $editor.filterText)

        ScrollView {
            LazyVStack(spacing: 0) {
                if !editor.enabledPacks.isEmpty {
                    SectionLabel(text: "Enabled (\(editor.enabledPacks.count))")
                    ForEach(editor.enabledPacks) { pack in
                        CheckRow(
                            name: pack.name,
                            description: pack.description,
                            trailing: {
                                Text(pack.type == "remote" ? "remote" : "local")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: true
                        ) {
                            editor.togglePack(pack.name)
                        }
                    }
                }

                if !editor.availablePacks.isEmpty {
                    SectionLabel(text: "Available (\(editor.availablePacks.count))")
                    ForEach(editor.availablePacks) { pack in
                        CheckRow(
                            name: pack.name,
                            description: pack.description,
                            trailing: {
                                Text(pack.type == "remote" ? "remote" : "local")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: false
                        ) {
                            editor.togglePack(pack.name)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }

        if editor.hasPendingChanges {
            PendingChangesBar(
                changeCount: editor.pendingChangeCount,
                onReset: { editor.resetPending() },
                onApply: { Task { await editor.applyPending() } }
            )
        }
    }
}
