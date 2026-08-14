import SwiftUI

struct BagsPanel: View {
    @Bindable var editor: IdentityEditor

    var body: some View {
        FilterBar(text: $editor.filterText)

        ScrollView {
            LazyVStack(spacing: 0) {
                if !editor.enabledBags.isEmpty {
                    SectionLabel(text: "Enabled (\(editor.enabledBags.count))")
                    ForEach(editor.enabledBags) { bag in
                        CheckRow(
                            name: bag.name,
                            description: bag.description,
                            trailing: {
                                Text(bag.type == "remote" ? "remote" : "local")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: true
                        ) {
                            editor.toggleBag(bag.name)
                        }
                    }
                }

                if !editor.availableBags.isEmpty {
                    SectionLabel(text: "Available (\(editor.availableBags.count))")
                    ForEach(editor.availableBags) { bag in
                        CheckRow(
                            name: bag.name,
                            description: bag.description,
                            trailing: {
                                Text(bag.type == "remote" ? "remote" : "local")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            },
                            isChecked: false
                        ) {
                            editor.toggleBag(bag.name)
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
