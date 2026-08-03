import SwiftUI

struct BlocksPanel: View {
    @Bindable var editor: ProfileEditor

    var body: some View {
        FilterBar(text: $editor.filterText)

        ScrollView {
            LazyVStack(spacing: 0) {
                if !editor.enabledBlocks.isEmpty {
                    SectionLabel(text: "Enabled (\(editor.enabledBlocks.count))")
                    ForEach(editor.enabledBlocks) { block in
                        CheckRow(
                            name: block.name,
                            description: block.description,
                            trailing: {
                                Text(block.type == "remote" ? "remote" : "local")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: true
                        ) {
                            editor.toggleBlock(block.name)
                        }
                    }
                }

                if !editor.availableBlocks.isEmpty {
                    SectionLabel(text: "Available (\(editor.availableBlocks.count))")
                    ForEach(editor.availableBlocks) { block in
                        CheckRow(
                            name: block.name,
                            description: block.description,
                            trailing: {
                                Text(block.type == "remote" ? "remote" : "local")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: false
                        ) {
                            editor.toggleBlock(block.name)
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
