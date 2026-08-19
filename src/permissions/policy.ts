import type {
    ApprovalResponse,
    TaskSpecContract,
} from "../spec/types.ts";
import type { ToolPermission } from "../tools/tool.ts";

export type PermissionDecision =
    | {
          readonly kind: "allow";
          readonly reason: "safe_read" | "allow_once" | "allow_session";
      }
    | {
          readonly kind: "approval_required";
          readonly allowedResponses: readonly ApprovalResponse[];
      }
    | {
          readonly kind: "deny";
          readonly code:
              | "action_forbidden"
              | "approval_unavailable"
              | "approval_response_invalid"
              | "denied_by_user";
          readonly message: string;
      };

type PermissionSpec = Pick<TaskSpecContract, "policy" | "userInteraction">;

export class PermissionPolicy {
    private readonly forbiddenActions: ReadonlySet<string>;
    private readonly approvalResponses: readonly ApprovalResponse[];
    private readonly sessionApprovals = new Set<string>();

    constructor(spec: PermissionSpec) {
        this.forbiddenActions = new Set(spec.policy.forbiddenActions);
        this.approvalResponses = [...spec.userInteraction.approvalResponses];
    }

    evaluate(permission: ToolPermission): PermissionDecision {
        if (this.forbiddenActions.has(permission.action)) {
            return {
                kind: "deny",
                code: "action_forbidden",
                message: `Action is forbidden by the task Spec: ${permission.action}`,
            };
        }

        if (permission.risk === "read") {
            return { kind: "allow", reason: "safe_read" };
        }

        if (this.sessionApprovals.has(permission.action)) {
            return { kind: "allow", reason: "allow_session" };
        }

        const allowedResponses = this.approvalResponses.filter(
            (response) => response !== "deny",
        );
        if (allowedResponses.length === 0) {
            return {
                kind: "deny",
                code: "approval_unavailable",
                message: `Action requires approval, but approval is unavailable: ${permission.action}`,
            };
        }

        return {
            kind: "approval_required",
            allowedResponses: [...this.approvalResponses],
        };
    }

    resolve(
        permission: ToolPermission,
        response: ApprovalResponse,
    ): PermissionDecision {
        const currentDecision = this.evaluate(permission);
        if (currentDecision.kind !== "approval_required") {
            return currentDecision;
        }

        if (!this.approvalResponses.includes(response)) {
            return {
                kind: "deny",
                code: "approval_response_invalid",
                message: `Approval response is not permitted by the task Spec: ${response}`,
            };
        }

        if (response === "deny") {
            return {
                kind: "deny",
                code: "denied_by_user",
                message: `Action was denied by the user: ${permission.action}`,
            };
        }

        if (response === "allow-session") {
            this.sessionApprovals.add(permission.action);
            return { kind: "allow", reason: "allow_session" };
        }

        return { kind: "allow", reason: "allow_once" };
    }
}
