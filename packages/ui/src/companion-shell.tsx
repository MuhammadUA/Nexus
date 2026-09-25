/**
 * Companion Side Panel chrome — spec `companion_extension`.
 *
 * One implementation shared by admin and user roles
 * (`companion_extension.shared_for_admin_and_user`): the role only changes which
 * options are offered in the selectors, never which components render.
 *
 * Layout is optimised for the 420px reference width
 * (`design_system.companion_reference`), with a tested minimum of 360px.
 */
import type { ReactElement, ReactNode } from 'react';

import { Button, Row, cx } from './primitives.js';

export interface SelectorOption {
  readonly value: string;
  readonly label: string;
}

/** Top-level surfaces: spec `companion_extension.top_level`. */
export type CompanionTopLevel = 'crm' | 'add';

/** CRM modules: spec `companion_extension.crm_modules`. */
export type CompanionModule = 'leads' | 'today' | 'search';

export interface CompanionShellProps {
  readonly topLevel: CompanionTopLevel;
  readonly module: CompanionModule;
  readonly onTopLevelChange: (level: CompanionTopLevel) => void;
  readonly onModuleChange: (module: CompanionModule) => void;

  readonly businesses: readonly SelectorOption[];
  readonly businessId: string;
  readonly onBusinessChange: (id: string) => void;

  readonly icps: readonly SelectorOption[];
  readonly icpId: string;
  readonly onIcpChange: (id: string) => void;

  /**
   * Sender identities the actor may use. Admin sessions get every identity their
   * scope permits, users only their assigned ones — the shell itself is identical.
   */
  readonly identities: readonly SelectorOption[];
  readonly identityId: string;
  readonly onIdentityChange: (id: string) => void;

  readonly counts?: Partial<Record<CompanionModule, number>>;

  /**
   * Ends the Companion session.
   *
   * The panel holds a Nexus token scoped to this browser profile. Without a way to drop it, an
   * operator on a shared machine has no way out, and "sign out" would only exist on the web app —
   * so the shell carries it.
   */
  readonly onSignOut?: () => void;
  readonly signOutBusy?: boolean;

  /** Rendered under the selectors: filters, warnings, list controls. */
  readonly filters?: ReactNode;
  readonly children: ReactNode;
  /** Sticky action area: Work Next, Mark sent, primary action for the screen. */
  readonly footer?: ReactNode;
}

export function CompanionShell({
  topLevel,
  module,
  onTopLevelChange,
  onModuleChange,
  businesses,
  businessId,
  onBusinessChange,
  icps,
  icpId,
  onIcpChange,
  identities,
  identityId,
  onIdentityChange,
  counts,
  filters,
  children,
  footer,
  onSignOut,
  signOutBusy,
}: CompanionShellProps): ReactElement {
  return (
    <div className="nx-companion">
      <header className="nx-companion__header">
        <div className="nx-companion__title-row">
          <span className="nx-companion__wordmark">Nexus</span>
          {topLevel === 'crm' && (
            <span className="nx-hint" style={{ marginLeft: 'auto' }}>
              Companion
            </span>
          )}
          {onSignOut !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              busy={signOutBusy === true}
              onClick={onSignOut}
            >
              Sign out
            </Button>
          )}
        </div>

        {/* Top level: [CRM View] [Add to CRM] */}
        <div className="nx-companion__topnav" role="tablist" aria-label="Companion view">
          <button
            type="button"
            role="tab"
            className="nx-companion__segment"
            aria-selected={topLevel === 'crm'}
            onClick={() => onTopLevelChange('crm')}
          >
            CRM View
          </button>
          <button
            type="button"
            role="tab"
            className="nx-companion__segment"
            aria-selected={topLevel === 'add'}
            onClick={() => onTopLevelChange('add')}
          >
            Add to CRM
          </button>
        </div>

        {/* Persistent selectors: business / ICP / sender identity */}
        <div className="nx-companion__selectors nx-companion__selectors--3" style={{ marginTop: 'var(--nx-space-sm)' }}>
          <label className="nx-visually-hidden" htmlFor="nx-c-business">
            Business
          </label>
          <select
            id="nx-c-business"
            className="nx-select"
            value={businessId}
            onChange={(event) => onBusinessChange(event.target.value)}
          >
            {businesses.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="nx-visually-hidden" htmlFor="nx-c-icp">
            ICP
          </label>
          <select id="nx-c-icp" className="nx-select" value={icpId} onChange={(event) => onIcpChange(event.target.value)}>
            {icps.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="nx-visually-hidden" htmlFor="nx-c-identity">
            Sender
          </label>
          <select
            id="nx-c-identity"
            className="nx-select"
            value={identityId}
            onChange={(event) => onIdentityChange(event.target.value)}
          >
            {identities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {topLevel === 'crm' && (
          <div className="nx-companion__topnav nx-companion__topnav--3" role="tablist" aria-label="CRM module" style={{ marginTop: 'var(--nx-space-sm)' }}>
            {(
              [
                ['leads', 'Leads'],
                ['today', 'Today'],
                ['search', 'Search'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                className="nx-companion__segment"
                aria-selected={module === key}
                onClick={() => onModuleChange(key)}
              >
                {label}
                {counts?.[key] !== undefined && (
                  <span className="nx-companion__segment__count">{counts[key]}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </header>

      {filters !== undefined && <div className="nx-companion__filters">{filters}</div>}

      <div className="nx-companion__body">{children}</div>

      {footer !== undefined && <div className="nx-companion__footer">{footer}</div>}
    </div>
  );
}

/** Compact lead row used by every Companion list (spec `.nx-lead-row`). */
export interface CompanionLeadRowProps {
  readonly name: string;
  readonly meta: ReactNode;
  readonly action?: ReactNode;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}

export function CompanionLeadRow({
  name,
  meta,
  action,
  selected,
  onClick,
}: CompanionLeadRowProps): ReactElement {
  return (
    <button
      type="button"
      className={cx('nx-lead-row')}
      aria-selected={selected === true ? true : undefined}
      onClick={onClick}
    >
      <span className="nx-lead-row__top">
        <span className="nx-lead-row__name">{name}</span>
      </span>
      <span className="nx-lead-row__meta">{meta}</span>
      {action !== undefined && <span className="nx-lead-row__action">{action}</span>}
    </button>
  );
}

/**
 * Footer action bar for a focus screen. `onWorkNext` is the
 * `My Day -> exact action -> next` loop the product intent is built around.
 */
export function WorkNextBar({
  label,
  onWorkNext,
  disabled,
  secondary,
}: {
  readonly label: string;
  readonly onWorkNext: () => void;
  readonly disabled?: boolean;
  readonly secondary?: ReactNode;
}): ReactElement {
  return (
    <Row between>
      <Button variant="primary" onClick={onWorkNext} disabled={disabled === true}>
        {label}
      </Button>
      {secondary}
    </Row>
  );
}
