import SwiftUI

struct TraitsPanel: View {
    @Bindable var editor: ProfileEditor

    var body: some View {
        FilterBar(text: $editor.filterText)

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SectionLabel(text: "Profile Default Traits")
                Text("Selected traits are automatically included in every session using this profile.")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)

                LazyVStack(spacing: 0) {
                    ForEach(editor.filteredTraits) { trait in
                        CheckRow(
                            name: trait.name,
                            description: trait.description,
                            trailing: {
                                AccessBadge(access: trait.access)
                                Text("\(trait.namespaces.count) ns")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: editor.selectedTraits.contains(trait.name)
                        ) {
                            editor.toggleTrait(trait.name)
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
