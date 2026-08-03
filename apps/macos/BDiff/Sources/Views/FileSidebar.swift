import SwiftUI
import BDiffCore

struct FileSidebar: View {
    @Bindable var appState: AppState
    @State private var filterText = ""

    private var filteredFiles: [DiffFile] {
        if filterText.isEmpty { return appState.files }
        let query = filterText.lowercased()
        return appState.files.filter {
            $0.newPath.lowercased().contains(query) || $0.oldPath.lowercased().contains(query)
        }
    }

    /// Session diffs group files under repo sections; other scopes are flat.
    private var repoSections: [(repoName: String?, files: [DiffFile])] {
        guard appState.isSessionScope else { return [(nil, filteredFiles)] }
        var order: [String] = []
        var byRepo: [String: [DiffFile]] = [:]
        for file in filteredFiles {
            let key = file.repoName ?? ""
            if byRepo[key] == nil { order.append(key) }
            byRepo[key, default: []].append(file)
        }
        return order.map { key in (key.isEmpty ? nil : key, byRepo[key] ?? []) }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Text("Changes")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.subtext1)

                Text("\(appState.files.count)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.overlay0)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Theme.surface1.opacity(0.4))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                Spacer()

                HStack(spacing: 5) {
                    Text("+\(appState.totalInsertions)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.added)
                    Text("-\(appState.totalDeletions)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.deleted)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            // Filter
            TextField("Filter...", text: $filterText)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Theme.surface0.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .strokeBorder(Theme.surface2.opacity(0.5), lineWidth: 0.5)
                )
                .padding(.horizontal, 10)
                .padding(.bottom, 8)

            Divider()

            // File list (grouped by repo in session scope)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(repoSections, id: \.repoName) { section in
                        if let repoName = section.repoName {
                            HStack(spacing: 6) {
                                Text(repoName.uppercased())
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Theme.overlay1)
                                Text("\(section.files.count)")
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(Theme.overlay0)
                                Spacer()
                            }
                            .padding(.horizontal, 14)
                            .padding(.top, 8)
                            .padding(.bottom, 3)
                        }
                        ForEach(section.files) { file in
                            FileRow(
                                file: file,
                                isSelected: file.id == appState.selectedFileId
                            )
                            .contentShape(Rectangle())
                            .onTapGesture {
                                appState.selectedFileId = file.id
                                appState.loadFileContentsForSelected()
                                // In stream mode, also expand if collapsed
                                if appState.viewMode == .stream && appState.isCollapsed(file.id) {
                                    appState.toggleCollapse(file.id)
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .background(Theme.base)
    }
}

private struct FileRow: View {
    let file: DiffFile
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 0) {
            // Status bar (thin left edge)
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Theme.statusColor(file.status))
                .frame(width: 3, height: 14)
                .padding(.trailing, 8)

            // File info
            VStack(alignment: .leading, spacing: 1) {
                Text(file.filename)
                    .font(.system(size: 12, weight: .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text(file.directory)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.overlay0)
                    .lineLimit(1)
                    .truncationMode(.head)
            }

            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(isSelected ? Theme.selectionBg : Color.clear)
        .overlay(alignment: .leading) {
            if isSelected {
                Rectangle()
                    .fill(Theme.accent)
                    .frame(width: 2)
            }
        }
    }
}
