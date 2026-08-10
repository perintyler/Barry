import SwiftUI

/// Centered label between two horizontal lines — used to separate conversation turns.
/// Example: `——— YOU ———`
public struct TurnSeparator: View {
    public let label: String
    public let lineColor: Color
    public let labelColor: Color

    public init(label: String, lineColor: Color, labelColor: Color) {
        self.label = label
        self.lineColor = lineColor
        self.labelColor = labelColor
    }

    public var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(lineColor)
                .frame(height: 1)

            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(labelColor)
                .fixedSize()

            Rectangle()
                .fill(lineColor)
                .frame(height: 1)
        }
    }
}
