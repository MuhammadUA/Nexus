/**
 * Shared types for the Companion.
 *
 * These mirror the JSON shapes the limited `/api/v1/companion/*` surface returns.
 * They are declared here rather than imported from `apps/web` because the extension
 * must not depend on server code — it only ever sees this narrow contract.
 */

export interface CompanionSession {
  readonly userId: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly role: 'admin' | 'manager' | 'user' | null;
}

export interface CompanionBusiness {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface CompanionIcp {
  readonly id: string;
  readonly name: string;
}

export interface CompanionIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly platform: string;
  readonly status: string;
}

/** The binding this browser profile has been assigned (spec U22). */
export interface BrowserBinding {
  readonly installId: string;
  readonly identityId: string;
  readonly defaultBusinessId: string | null;
  readonly boundAt: string;
}

export interface CompanionLead {
  readonly id: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly jobTitle: string | null;
  readonly status: string;
  readonly isDnc: boolean;
  readonly needsProfile: boolean;
  readonly linkedinUrl: string | null;
  readonly identityName: string | null;
  readonly nextActionType: string | null;
  readonly nextActionAt: string | null;
}

export interface CompanionTodayItem {
  readonly leadId: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly category: string;
  readonly stepOrder: number | null;
  readonly dueAt: string | null;
  readonly isOverdue: boolean;
  readonly messageInstanceId: string | null;
  readonly taskId: string | null;
  readonly leadState: string | null;
}

export interface CompanionLeadDetail {
  readonly lead: CompanionLead;
  readonly currentMessage: {
    readonly id: string;
    readonly stepOrder: number;
    readonly state: 'DYNAMIC' | 'LOCKED' | 'SENT';
    readonly content: string | null;
    readonly dueAt: string | null;
    readonly sentAt: string | null;
  } | null;
  readonly recentHistory: readonly {
    readonly id: string;
    readonly at: string;
    readonly kind: string;
    readonly body: string | null;
    readonly summary: string | null;
  }[];
  readonly sequence: {
    readonly state: string | null;
    readonly currentStepOrder: number | null;
    readonly reactivationDueAt: string | null;
    readonly dormantAt: string | null;
    readonly priorSteps: readonly { readonly stepOrder: number; readonly sentAt: string | null }[];
  };
}

export interface SearchResult {
  /** A Person may be a Lead in several businesses; each is a separate choice. */
  readonly leadId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly status: string;
  readonly lastActivityAt: string | null;
  readonly nextActionAt: string | null;
  readonly nextActionType: string | null;
}

export interface ApiFailure {
  readonly ok: false;
  readonly error: string;
  readonly status: number;
  /**
   * A machine-readable reason, when the failure is a decision rather than a fault.
   *
   * `identity_in_use` is the one that matters: the bind was refused because another browser
   * profile holds the sender identity, and the panel has to offer "Cancel / Transfer to this
   * browser" rather than repeating the sentence back at the operator.
   */
  readonly reason?: string;
  readonly canTransfer?: boolean;
  readonly conflicts?: readonly IdentityConflict[];
  readonly blocked?: boolean;
}

/** Another browser profile currently holding the identity the operator selected. */
export interface IdentityConflict {
  readonly sessionId: string;
  readonly operatorName: string | null;
  readonly lastActiveAt: string;
  /** True when the holder is the operator's own other browser profile. */
  readonly isSelf: boolean;
}

export type ApiResult<T> = ({ readonly ok: true } & T) | ApiFailure;
