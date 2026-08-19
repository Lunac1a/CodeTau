export type StructuredEdit = {
    readonly oldText: string;
    readonly newText: string;
};

export type StructuredPatchResult =
    | {
          readonly ok: true;
          readonly content: string;
          readonly editsApplied: number;
      }
    | {
          readonly ok: false;
          readonly error: {
              readonly code:
                  | "patch_edit_invalid"
                  | "patch_context_missing"
                  | "patch_context_ambiguous";
              readonly message: string;
              readonly editIndex: number;
          };
      };

export function applyStructuredEdits(
    originalContent: string,
    edits: readonly StructuredEdit[],
): StructuredPatchResult {
    if (edits.length === 0) {
        return {
            ok: false,
            error: {
                code: "patch_edit_invalid",
                message: "A structured patch must contain at least one edit",
                editIndex: 0,
            },
        };
    }

    let content = originalContent;
    for (const [editIndex, edit] of edits.entries()) {
        if (edit.oldText === "" || edit.oldText === edit.newText) {
            return {
                ok: false,
                error: {
                    code: "patch_edit_invalid",
                    message:
                        edit.oldText === ""
                            ? `Edit ${editIndex} must include non-empty oldText`
                            : `Edit ${editIndex} does not change the file`,
                    editIndex,
                },
            };
        }

        const firstMatch = content.indexOf(edit.oldText);
        if (firstMatch === -1) {
            return {
                ok: false,
                error: {
                    code: "patch_context_missing",
                    message: `Edit ${editIndex} oldText was not found`,
                    editIndex,
                },
            };
        }
        if (content.indexOf(edit.oldText, firstMatch + 1) !== -1) {
            return {
                ok: false,
                error: {
                    code: "patch_context_ambiguous",
                    message: `Edit ${editIndex} oldText matched more than once`,
                    editIndex,
                },
            };
        }

        content =
            content.slice(0, firstMatch) +
            edit.newText +
            content.slice(firstMatch + edit.oldText.length);
    }

    return { ok: true, content, editsApplied: edits.length };
}
