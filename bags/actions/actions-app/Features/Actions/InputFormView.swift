import Components
import SwiftUI

/// An action's declared inputs, as controls.
///
/// Every field is optional to fill. A default is shown as a PLACEHOLDER rather
/// than pre-typed text: greyed prompt text is the visual language of "this is
/// what happens if you say nothing", and it keeps the touched bit honest —
/// `!text.isEmpty` — with no second set to fall out of sync. Sending a default
/// the user never looked at would read as a decision and stop the agent
/// inferring one. See docs/actions.md, "Soft inputs".
struct InputFormView: View {
    let fields: [InputField]
    @Binding var draft: InputDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(fields) { field in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(field.title)
                            .font(AppFont.sans(size: 11, weight: .medium))
                        if field.isRequired {
                            Text("required")
                                .font(AppFont.sans(size: 9))
                                .foregroundStyle(Palette.amber)
                        }
                    }

                    control(for: field)
                        .accessibilityIdentifier("input:\(field.name)")

                    if let help = field.help, !help.isEmpty {
                        Text(help)
                            .font(AppFont.sans(size: 9))
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    /// The placeholder for a field: its default, or a nudge that saying
    /// nothing is fine. Never empty — an unlabelled empty box gives the user
    /// no way to tell an optional field from one that lost its label.
    private func placeholder(_ field: InputField) -> String {
        field.defaultDisplay ?? "optional"
    }

    private func binding(_ field: InputField) -> Binding<String> {
        Binding(
            get: { draft.text[field.name] ?? "" },
            set: { draft.text[field.name] = $0 }
        )
    }

    @ViewBuilder
    private func control(for field: InputField) -> some View {
        switch field.kind {
        case .text:
            TextField(placeholder(field), text: binding(field))
                .textFieldStyle(.roundedBorder)
                .font(AppFont.sans(size: 11))

        case .multiline:
            TextField(placeholder(field), text: binding(field), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...6)
                .font(AppFont.sans(size: 11))

        case let .number(isInteger):
            TextField(placeholder(field), text: binding(field))
                .textFieldStyle(.roundedBorder)
                .font(AppFont.mono(size: 11))
                .help(isInteger ? "Whole number" : "Number")

        case .toggle:
            // No empty state, so this records itself as touched the moment it
            // moves — otherwise switching it OFF would be indistinguishable
            // from never having touched it, and would never be sent.
            Toggle(
                "",
                isOn: Binding(
                    get: { (draft.text[field.name] ?? field.defaultDisplay) == "true" },
                    set: {
                        draft.text[field.name] = $0 ? "true" : "false"
                        draft.touched.insert(field.name)
                    }
                )
            )
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.mini)

        case let .choice(options):
            // The one closed control: the schema says these are the only legal
            // values, so offering a text box would invite a 422.
            Picker("", selection: Binding(
                get: { draft.text[field.name] ?? "" },
                set: {
                    draft.text[field.name] = $0
                    draft.touched.insert(field.name)
                }
            )) {
                Text(field.defaultDisplay.map { "\($0) (default)" } ?? "Leave open").tag("")
                ForEach(options, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .controlSize(.small)

        case let .suggestion(options):
            // A combo box, not a picker with an "Other…" row. The schema said
            // these merely SUGGEST — a named theme, a freeform vibe, or
            // "surprise me" are equally legal — and a mode switch would make
            // the freeform case second-class when it is often the primary one.
            HStack(spacing: 4) {
                TextField(placeholder(field), text: binding(field))
                    .textFieldStyle(.roundedBorder)
                    .font(AppFont.sans(size: 11))
                Menu {
                    ForEach(options, id: \.self) { option in
                        Button(option) { draft.text[field.name] = option }
                    }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("Suggestions — any value is accepted")
            }

        case .json:
            // A shape the form cannot model. Shown as raw JSON rather than
            // hidden: a field that silently disappears reads as an action that
            // never declared it.
            TextField(placeholder(field), text: binding(field), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...5)
                .font(AppFont.mono(size: 10))
                .help("JSON value")
        }
    }
}
