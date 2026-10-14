const BANNER_RULE = /^\s*[=\-*_]{6,}\s*$/;
const HISTORY_RULE = /(?:^|\n)\s*\*?\s*(?:This used to|It used to|Found 2026-|measured 2026-)|\b\d{4}-\d{2}-\d{2}\b/;

export const commentsPlugin = {
  rules: {
    "no-banner-comment": {
      meta: {
        type: "suggestion", fixable: "whitespace", schema: [],
        messages: {
          banner: "Banner rule line. Delete it; keep any reason or invariant as a plain comment.",
          history: "Move dated history to an ADR or git. A dated invariant requires '-- why:' and its reason.",
        },
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === "Line" && BANNER_RULE.test(comment.value)) {
                context.report({ node: comment, messageId: "banner", fix: fixer => fixer.remove(comment) });
              }
              if (HISTORY_RULE.test(comment.value) && !/-- why:\s+\S/.test(comment.value)) context.report({ node: comment, messageId: "history" });
            }
          },
        };
      },
    },
  },
};
