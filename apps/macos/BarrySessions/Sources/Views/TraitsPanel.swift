import SwiftUI

struct TraitsPanel: View {
    @Bindable var editor: SessionEditor

    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(editor.filteredTraits) { trait in
                CheckRow(
                    name: trait.name,
                    description: trait.description,
                    trailing: {
                        AccessBadge(access: trait.access)
                        Text("\(trait.namespaces.count) ns")
                            .font(AppFont.sans(size: 11))
                            .foregroundStyle(.tertiary)
                    },
                    isChecked: editor.selectedTraits.contains(trait.name)
                ) {
                    editor.toggleTrait(trait.name)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct NamespacesPanel: View {
    @Bindable var editor: SessionEditor

    var body: some View {
        LazyVStack(spacing: 0) {
            // Directly selected namespaces
            let directlySelected = editor.filteredNamespaces.filter {
                editor.selectedNamespaces.contains($0.name)
            }
            if !directlySelected.isEmpty {
                SectionLabel(text: "Directly Selected")
                ForEach(directlySelected) { ns in
                    CheckRow(
                        name: ns.name,
                        description: nil,
                        trailing: {
                            Text("\(ns.toolCount) tools")
                                .font(AppFont.sans(size: 11))
                                .foregroundStyle(.tertiary)
                        },
                        isChecked: true
                    ) {
                        editor.toggleNamespace(ns.name)
                    }
                }
            }

            // Remaining namespaces (trait-granted shown as partial, others unchecked)
            let remaining = editor.filteredNamespaces.filter {
                !editor.selectedNamespaces.contains($0.name)
            }
            ForEach(remaining) { ns in
                let isViaTrait = editor.traitGrantedNamespaces.contains(ns.name)
                let grantedBy = isViaTrait ? editor.grantingTraits(for: ns.name).joined(separator: ", ") : nil
                let desc = grantedBy.map { "via \($0)" }

                CheckRow(
                    name: ns.name,
                    description: desc,
                    trailing: {
                        Text("\(ns.toolCount) tools")
                            .font(AppFont.sans(size: 11))
                            .foregroundStyle(.tertiary)
                    },
                    state: isViaTrait ? .partial : .unchecked,
                    isInert: isViaTrait
                ) {
                    editor.toggleNamespace(ns.name)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct ToolsPanel: View {
    @Bindable var editor: SessionEditor

    var body: some View {
        LazyVStack(spacing: 0) {
            // Directly selected tools
            let directlySelected = editor.filteredTools.filter {
                editor.selectedTools.contains($0.toolName)
            }
            if !directlySelected.isEmpty {
                SectionLabel(text: "Directly Selected")
                ForEach(directlySelected) { tool in
                    CheckRow(
                        name: tool.toolName,
                        description: tool.namespace,
                        isMonospace: true,
                        trailing: {
                            AccessBadge(access: tool.access)
                        },
                        isChecked: true
                    ) {
                        editor.toggleTool(tool.toolName)
                    }
                }
            }

            // Enabled via traits/namespaces (partial check, inert)
            let viaTrait = editor.filteredTools.filter {
                !editor.selectedTools.contains($0.toolName) &&
                editor.enabledTools.contains($0.toolName)
            }
            if !viaTrait.isEmpty {
                SectionLabel(text: "Enabled via Traits / Namespaces (\(viaTrait.count))")
                ForEach(viaTrait) { tool in
                    CheckRow(
                        name: tool.toolName,
                        description: tool.namespace,
                        isMonospace: true,
                        trailing: {
                            AccessBadge(access: tool.access)
                        },
                        state: .partial,
                        isInert: true
                    ) {}
                }
            }

            // Available (not enabled)
            let available = editor.filteredTools.filter {
                !editor.selectedTools.contains($0.toolName) &&
                !editor.enabledTools.contains($0.toolName)
            }
            if !available.isEmpty {
                SectionLabel(text: "Available (\(available.count))")
                ForEach(available) { tool in
                    CheckRow(
                        name: tool.toolName,
                        description: tool.namespace,
                        isMonospace: true,
                        trailing: {
                            AccessBadge(access: tool.access)
                        },
                        isChecked: false
                    ) {
                        editor.toggleTool(tool.toolName)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
