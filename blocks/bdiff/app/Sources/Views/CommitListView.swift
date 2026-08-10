import SwiftUI
import BDiffCore

struct CommitListView: View {
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Commits")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.subtext1)
                Spacer()
                Text("\(appState.commits.count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.overlay0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            if appState.commits.isEmpty {
                VStack(spacing: 8) {
                    Text("No commits")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.subtext1)
                    Text("No commits on this branch yet")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.overlay0)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(appState.commits) { commit in
                            CommitRow(
                                commit: commit,
                                isSelected: commit.hash == appState.selectedCommitHash
                            )
                            .contentShape(Rectangle())
                            .onTapGesture {
                                appState.selectCommit(commit.hash)
                            }
                        }
                    }
                }
            }
        }
        .background(Theme.base)
    }
}

private struct CommitRow: View {
    let commit: GitCommit
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(commit.subject)
                .font(.system(size: 12))
                .lineLimit(2)
                .foregroundStyle(Theme.text)

            HStack(spacing: 6) {
                Text(commit.shortHash)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.subtext1)

                Text(commit.author)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.overlay1)
                    .lineLimit(1)

                Spacer()

                if let files = commit.filesChanged, files > 0 {
                    HStack(spacing: 3) {
                        if let ins = commit.insertions, ins > 0 {
                            Text("+\(ins)")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(Theme.added)
                        }
                        if let del = commit.deletions, del > 0 {
                            Text("-\(del)")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(Theme.deleted)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(isSelected ? Theme.selectionBg : Color.clear)
    }
}
