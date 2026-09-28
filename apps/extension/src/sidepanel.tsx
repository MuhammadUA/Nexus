/**
 * Nexus Companion side panel.
 *
 * ONE implementation shared by admin and user roles
 * (spec `companion_extension.shared_for_admin_and_user`): the role only widens which
 * selectors and actions are offered, never which components render.
 *
 * Surface map (spec `companion_extension`):
 *   top level  [CRM View] [Add to CRM]
 *   CRM View   [Leads] [Today] [Search]  -> all three open the SAME lead context
 *
 * Opening a prospect's profile happens in the active browser tab
 * (`chrome.tabs.update`), so the panel stays open beside it — spec
 * `open_linkedin_behavior`.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  Alert,
  Button,
  Chip,
  CompanionShell,
  CompanionLeadRow,
  DueChip,
  Field,
  LeadStatusChip,
  MessageBlock,
  MessageStateChip,
  Row,
  Select,
  Stack,
  TextArea,
  TextInput,
  type CompanionModule,
  type CompanionTopLevel,
} from '@nexus/ui';

import * as api from './api';
import { companionScope, shellBusinesses } from './binding-scope';
import { clearSession, openInActiveTab, openSearchInNewTab } from './chrome-actions';
import { enrichmentAccent, enrichmentLabel, intelligenceLabel, needsFindLinkedIn } from './enrichment-view';
import type {
  BrowserBinding,
  CompanionBusiness,
  CompanionIcp,
  CompanionIdentity,
  CompanionLead,
  CompanionLeadDetail,
  CompanionSession,
  CompanionTodayItem,
  IdentityConflict,
  SearchResult,
} from './types';
import { useListState, type ListState } from './use-list-state';

type Screen = 'list' | 'focus' | 'reply' | 'reactivate';

/** REACTIVATION/outcome vocabulary is fixed by spec `sequence_engine.reply_outcomes`. */
const REPLY_OUTCOMES = [
  'Interested',
  'Positive / needs info',
  'Maybe later',
  'No current need',
  'Not interested',
  'Wrong person',
  'Already has supplier',
  'Do not contact',
  'Other',
] as const;

export function SidePanel(): ReactElement {
  const listState = useListState();

  const [session, setSession] = useState<CompanionSession | null>(null);
  const [businesses, setBusinesses] = useState<readonly CompanionBusiness[]>([]);
  const [identities, setIdentities] = useState<readonly CompanionIdentity[]>([]);
  const [binding, setBinding] = useState<BrowserBinding | null>(null);
  const [concurrency, setConcurrency] = useState<{ action: string; reason: string } | null>(null);
  const [icps, setIcps] = useState<readonly CompanionIcp[]>([]);

  const [topLevel, setTopLevel] = useState<CompanionTopLevel>('crm');
  const [module, setModule] = useState<CompanionModule>('leads');
  const [screen, setScreen] = useState<Screen>('list');

  const [leads, setLeads] = useState<readonly CompanionLead[]>([]);
  const [todayItems, setTodayItems] = useState<readonly CompanionTodayItem[]>([]);
  const [searchResults, setSearchResults] = useState<readonly SearchResult[]>([]);
  const [detail, setDetail] = useState<CompanionLeadDetail | null>(null);

  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  const businessId = listState.state.businessId;
  const identityId = listState.state.identityId;

  /**
   * The bind scope for the chosen channel account.
   *
   * spec §36 / §61: the business selector offers only the businesses the selected
   * account may send from. `companionScope` is pure and is the same function the web
   * test suite exercises, so the recalculation can be asserted without a browser.
   */
  const scope = useMemo(
    () =>
      companionScope({
        businesses,
        identities,
        identityId,
        businessId,
        preferredBusinessId: binding?.defaultBusinessId ?? null,
      }),
    [binding, businessId, businesses, identities, identityId],
  );

  /**
   * What the shell's business selector shows.
   *
   * Same rule as the bind selector; the one difference is the unknown-account case —
   * a binding that names an account the server no longer offers has no scope to apply,
   * and hiding every business would take the panel down for an operator whose data is
   * still theirs to read. `shellBusinesses` falls back to the accessible list there,
   * and the footer says so.
   */
  const shellBusinessList = useMemo(
    () => shellBusinesses(businesses, identities, identityId),
    [businesses, identities, identityId],
  );

  const refresh = useCallback(
    async (targetModule: CompanionModule = module) => {
      if (!listState.ready) return;
      if (businessId.length === 0) return;

      setBusy(true);
      setError(null);
      try {
        if (targetModule === 'leads') {
          const result = await api.leads({
            businessId,
            icpId: listState.state.icpId,
            status: listState.state.statusFilter,
            search: listState.state.search,
          });
          if (result.ok) setLeads(result.leads);
          else setError(result.error);
        } else if (targetModule === 'today') {
          if (session === null) return;
          const result = await api.today({ businessId, userId: session.userId });
          if (result.ok) setTodayItems(result.items);
          else setError(result.error);
        }
      } finally {
        setBusy(false);
      }
    },
    [businessId, listState.ready, listState.state.icpId, listState.state.search, listState.state.statusFilter, module, session],
  );

  /* --------------------------------------------------------------- boot -- */

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.local.get('nexus.installId');
      const existing: unknown = stored['nexus.installId'];
      const installId =
        typeof existing === 'string' && existing.length > 0 ? existing : crypto.randomUUID();
      if (typeof existing !== 'string') await chrome.storage.local.set({ 'nexus.installId': installId });

      const result = await api.bootstrap(installId);
      if (result.ok) {
        setSession(result.session);
        setBusinesses(result.businesses);
        setIdentities(result.identities);
        setBinding(result.binding);
        setConcurrency(result.concurrency);
      }
      setBooted(true);
    })();
  }, []);

  // Load ICPs whenever the business changes, and keep the selection valid.
  useEffect(() => {
    void (async () => {
      if (businessId.length === 0) {
        setIcps([]);
        return;
      }
      const result = await api.icps(businessId);
      if (result.ok) setIcps(result.icps);
    })();
  }, [businessId]);

  /**
   * Defaults and recalculates the selectors.
   *
   * One effect rather than two, because the two selectors are no longer independent:
   * the identity decides which businesses exist, so the identity is resolved first and
   * the business selection is then validated against it. A selection the newly chosen
   * account cannot reach is replaced — by the stored binding's business when that is
   * eligible, otherwise by the first eligible one, otherwise cleared — and the ICP is
   * cleared with it, because an ICP belongs to a business.
   *
   * The patch is only written when something actually differs, which is what keeps
   * this from looping through `chrome.storage.local`.
   */
  useEffect(() => {
    if (!listState.ready) return;

    const nextIdentityId =
      identityId.length > 0 ? identityId : (binding?.identityId ?? identities[0]?.id ?? '');
    if (nextIdentityId.length === 0) return;

    const patch: { [K in 'identityId' | 'businessId' | 'icpId']?: ListState[K] } = {};
    if (nextIdentityId !== identityId) patch.identityId = nextIdentityId;

    // An account the server does not list has no scope to apply: the business
    // selection is left alone rather than silently emptied.
    const known = identities.some((candidate) => candidate.id === nextIdentityId);
    if (known) {
      const next = companionScope({
        businesses,
        identities,
        identityId: nextIdentityId,
        businessId,
        preferredBusinessId: binding?.defaultBusinessId ?? null,
      });
      if (next.businessId !== businessId) {
        patch.businessId = next.businessId;
        patch.icpId = '';
      }
    }

    if (Object.keys(patch).length > 0) listState.update(patch);
  }, [binding, businessId, businesses, identities, identityId, listState]);

  // Reload the active list when its inputs change.
  useEffect(() => {
    if (module === 'search') return;
    void refresh(module);
  }, [refresh, module, businessId, listState.state.icpId, listState.state.statusFilter, listState.state.search]);

  const activeLead = useMemo(
    () => leads.find((lead) => lead.id === activeLeadId) ?? null,
    [leads, activeLeadId],
  );

  const openLead = useCallback(
    async (leadId: string, target: Screen) => {
      setActiveLeadId(leadId);
      setError(null);
      setBusy(true);
      try {
        const result = await api.leadDetail(leadId);
        if (result.ok) {
          setDetail(result.detail);
          setScreen(target);
        } else {
          setError(result.error);
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /** Opens the prospect's profile in the active tab; the panel stays open. */
  const openLinkedIn = useCallback(async (url: string | null) => {
    if (url === null || url.length === 0) {
      setError('This lead has no LinkedIn URL recorded. Add one from Edit lead on the web app.');
      return;
    }
    const outcome = await openInActiveTab(url);
    if (outcome === 'invalid') {
      setError('That is not a LinkedIn profile URL, so it was not opened.');
    }
  }, []);

  /**
   * Opens the generated "Find LinkedIn" search for a lead with no profile URL yet.
   *
   * Always a *new* tab: the search is a detour, and the operator's LinkedIn tab is
   * where the result will be pasted back from. The URL comes from the server
   * (`searchLinks` in `@nexus/core`) and is re-validated here before anything is
   * navigated, because a URL that reached the panel is still input.
   */
  const findLinkedIn = useCallback(async (url: string | null) => {
    if (url === null || url.length === 0) return;
    const outcome = await openSearchInNewTab(url);
    if (outcome === 'invalid') {
      setError('That search link was not a Google search URL, so it was not opened.');
    }
  }, []);

  /**
   * Signs out: clears the stored token, then returns the panel to its first screen.
   *
   * `api.signOut` also tells the server to revoke the token, which is what makes this a real
   * sign-out rather than only forgetting it locally. A revocation failure is not worth blocking
   * on — the token is gone from this browser either way, and the panel must not stay signed in
   * because the network was down.
   */
  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await api.signOut().catch(() => undefined);
      await clearSession();
      setSession(null);
      setBinding(null);
      setLeads([]);
      setTodayItems([]);
      setSearchResults([]);
      setDetail(null);
      setActiveLeadId(null);
      setScreen('list');
      setTopLevel('crm');
      setModule('leads');
      setNotice('Signed out.');
      setError(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error ?? 'That did not work.');
          return;
        }
        setNotice(success);
        await refresh(module);
        if (activeLeadId !== null) {
          const refreshed = await api.leadDetail(activeLeadId);
          if (refreshed.ok) setDetail(refreshed.detail);
        }
      } finally {
        setBusy(false);
      }
    },
    [activeLeadId, module, refresh],
  );

  /* ---------------------------------------------------------- not bound -- */

  if (!booted) {
    return (
      <div className="nx-companion">
        <div className="nx-companion__body">
          <span className="nx-hint">Loading Nexus Companion…</span>
        </div>
      </div>
    );
  }

  if (session === null || binding === null) {
    return (
      <BindPanel
        session={session}
        businesses={businesses}
        identities={identities}
        reason={
          session === null
            ? 'Sign in with your Nexus account, then choose the LinkedIn identity this browser profile uses.'
            : 'Choose the LinkedIn identity this browser profile uses.'
        }
        onDone={async () => {
          const stored = await chrome.storage.local.get('nexus.installId');
          const installId = String(stored['nexus.installId'] ?? '');
          const result = await api.bootstrap(installId);
          if (result.ok) {
            setSession(result.session);
            setBusinesses(result.businesses);
            setIdentities(result.identities);
            setBinding(result.binding);
            setConcurrency(result.concurrency);
          }
        }}
      />
    );
  }

  const counts: Partial<Record<CompanionModule, number>> = {
    leads: leads.length,
    today: todayItems.length,
  };

  const selectedIndex = leads.findIndex((lead) => lead.id === activeLeadId);

  return (
    <CompanionShell
      topLevel={topLevel}
      module={module}
      onTopLevelChange={(level) => {
        setTopLevel(level);
        setScreen('list');
        if (level === 'add') setModule('leads');
      }}
      onModuleChange={(next) => {
        setModule(next);
        setScreen('list');
      }}
      businesses={shellBusinessList.map((business) => ({ value: business.id, label: business.name }))}
      businessId={businessId}
      onBusinessChange={(id) => listState.update({ businessId: id, icpId: '' })}
      icps={[{ value: '', label: 'All ICPs' }, ...icps.map((icp) => ({ value: icp.id, label: icp.name }))]}
      icpId={listState.state.icpId}
      onIcpChange={(id) => listState.update({ icpId: id })}
      identities={identities.map((identity) => ({ value: identity.id, label: identity.displayName }))}
      identityId={identityId}
      onIdentityChange={(id) => listState.update({ identityId: id })}
      counts={counts}
      onSignOut={() => void signOut()}
      signOutBusy={busy}
      filters={
        topLevel === 'crm' && module === 'leads' ? (
          <Row wrap>
            <Chip accent="indigo">{leads.length} leads</Chip>
            <Chip>{listState.state.statusFilter === '' ? 'all statuses' : listState.state.statusFilter}</Chip>
          </Row>
        ) : null
      }
      footer={
        <Stack size="sm">
          {/*
            The empty-scope state is explained rather than rendered as an empty
            selector: an operator seeing no businesses needs to know whether the
            account is unassigned or they are missing a grant.
          */}
          {shellBusinessList.length === 0 && businessId.length === 0 && (
            <Alert accent="amber" role="status">
              {scope.message.length > 0
                ? scope.message
                : 'No business is available for the selected channel account.'}
            </Alert>
          )}
          {concurrency !== null && concurrency.action !== 'allow' && (
            <Alert accent={concurrency.action === 'block' ? 'red' : 'amber'} role="alert">
              {concurrency.reason}
            </Alert>
          )}
          {error !== null && (
            <Alert accent="red" role="alert">
              {error}
            </Alert>
          )}
          {notice !== null && (
            <Alert accent="green" role="status">
              {notice}
            </Alert>
          )}
          {screen === 'list' && (
            <Row between>
              <span className="nx-hint">
                {activeLead === null
                  ? binding.identityId === identityId
                    ? 'bound sender'
                    : 'sender changed'
                  : `selected: ${activeLead.personName}`}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void refresh(module)} busy={busy}>
                Refresh
              </Button>
            </Row>
          )}
        </Stack>
      }
    >
      {topLevel === 'add' ? (
        <AddToCrm
          businesses={shellBusinessList}
          icps={icps}
          businessId={businessId}
          icpId={listState.state.icpId}
          identityId={identityId}
          busy={busy}
          onError={setError}
          onCreated={(leadId) => {
            setNotice('Added to Nexus.');
            setTopLevel('crm');
            setModule('leads');
            void openLead(leadId, 'focus');
          }}
        />
      ) : screen === 'focus' && detail !== null ? (
        <ActionFocus
          detail={detail}
          identityId={identityId}
          busy={busy}
          onOpenLinkedIn={() => void openLinkedIn(detail.lead.linkedinUrl)}
          onFindLinkedIn={(url) => void findLinkedIn(url)}
          onMarkConnection={(withNote) =>
            void run(
              () => api.markConnectionSent({ leadId: detail.lead.id, identityId, withNote }),
              withNote ? 'Connection recorded with note.' : 'Connection recorded without note.',
            )
          }
          onMarkMessageSent={() => {
            const instanceId = detail.currentMessage?.id;
            if (instanceId === undefined) return;
            void run(
              () => api.markMessageSent({ messageInstanceId: instanceId, identityId }),
              'Marked sent. The content is now immutable.',
            );
          }}
          onSnooze={(until) =>
            void run(() => api.snooze({ leadId: detail.lead.id, until, reason: null }), 'Snoozed.')
          }
          onCaptureReply={() => setScreen('reply')}
          onReactivate={() => setScreen('reactivate')}
          onBack={() => setScreen('list')}
        />
      ) : screen === 'reply' && detail !== null ? (
        <ReplyAndNotes
          detail={detail}
          busy={busy}
          onBack={() => setScreen('focus')}
          onSave={(exactText, outcome, note) =>
            void run(
              () => api.captureReply({ leadId: detail.lead.id, exactText, outcome, note }),
              'Reply recorded and pending steps paused.',
            )
          }
        />
      ) : screen === 'reactivate' && detail !== null ? (
        <ReactivationFocus
          detail={detail}
          busy={busy}
          onBack={() => setScreen('focus')}
          onStart={() =>
            void run(() => api.startReactivation(detail.lead.id), 'Reactivation opened.')
          }
        />
      ) : module === 'search' ? (
        <SearchPanel
          results={searchResults}
          busy={busy}
          onSearch={async (query) => {
            setBusy(true);
            setError(null);
            try {
              const result = await api.search(query);
              if (result.ok) setSearchResults(result.results);
              else setError(result.error);
            } finally {
              setBusy(false);
            }
          }}
          onOpen={(leadId) => void openLead(leadId, 'focus')}
          onFindLinkedIn={(url) => void findLinkedIn(url)}
        />
      ) : module === 'today' ? (
        <TodayPanel
          items={todayItems}
          selectedIndex={selectedIndex}
          onOpen={(leadId) => void openLead(leadId, 'focus')}
          onFindLinkedIn={(url) => void findLinkedIn(url)}
        />
      ) : (
        <LeadsPanel
          leads={leads}
          activeLeadId={activeLeadId}
          busy={busy}
          onOpen={(leadId) => void openLead(leadId, 'focus')}
          onFindLinkedIn={(url) => void findLinkedIn(url)}
        />
      )}
    </CompanionShell>
  );
}

/* ----------------------------------------------------------- bind (U22) -- */

function BindPanel({
  session,
  businesses,
  identities,
  reason,
  onDone,
}: {
  readonly session: CompanionSession | null;
  readonly businesses: readonly CompanionBusiness[];
  readonly identities: readonly CompanionIdentity[];
  readonly reason: string;
  readonly onDone: () => Promise<void>;
}): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [identityId, setIdentityId] = useState(identities[0]?.id ?? '');
  const [defaultBusinessId, setDefaultBusinessId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The account drives the business list (spec §36 / §61).
   *
   * `identities` carries, per account, exactly the businesses the server will accept a
   * bind for, so the selector can only offer a bindable pair and the Bind control knows
   * — before the request — when there is nothing to bind. Switching the account
   * recalculates this: an eligible selection is kept, an ineligible one is replaced or
   * cleared.
   */
  const scope = useMemo(
    () =>
      companionScope({
        businesses,
        identities,
        identityId,
        businessId: defaultBusinessId,
      }),
    [businesses, defaultBusinessId, identities, identityId],
  );

  // Keeps the controlled select in step with the recalculation.
  useEffect(() => {
    if (scope.businessId !== defaultBusinessId) setDefaultBusinessId(scope.businessId);
  }, [defaultBusinessId, scope.businessId]);

  /**
   * The account list arrives *after* sign-in, so the selection is reconciled when it does.
   *
   * Without this the panel stayed on "no channel account" — and, because the Bind control is
   * now disabled when nothing is eligible, an operator who had just signed in could not get
   * past the screen at all. An account that disappears is replaced for the same reason.
   */
  useEffect(() => {
    if (identityId.length === 0) {
      const first = identities[0]?.id ?? '';
      if (first.length > 0) setIdentityId(first);
      return;
    }
    if (!identities.some((identity) => identity.id === identityId)) {
      setIdentityId(identities[0]?.id ?? '');
    }
  }, [identities, identityId]);
  /**
   * Set when the API refused the bind because another browser profile holds the identity.
   *
   * The refusal is a decision, not a fault, so it is held separately from `error`: the panel
   * shows who holds the identity and offers Cancel or Transfer instead of just the sentence.
   */
  const [conflict, setConflict] = useState<{
    readonly message: string;
    readonly canTransfer: boolean;
    readonly conflicts: readonly IdentityConflict[];
  } | null>(null);

  const bind = async (transfer: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const stored = await chrome.storage.local.get('nexus.installId');
      const result = await api.bindBrowser({
        installId: String(stored['nexus.installId'] ?? ''),
        identityId,
        // Taken from the recalculated scope rather than from state, so the request can
        // never carry a selection the current account invalidated.
        defaultBusinessId: scope.businessId.length === 0 ? null : scope.businessId,
        ...(transfer ? { transfer: true } : {}),
      });
      if (!result.ok) {
        if (result.reason === 'identity_in_use') {
          setConflict({
            message: result.error,
            canTransfer: result.canTransfer === true,
            conflicts: result.conflicts ?? [],
          });
          return;
        }
        setError(result.error);
        return;
      }
      setConflict(null);
      await api.setBinding(result.binding);
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nx-companion">
      <header className="nx-companion__header">
        <div className="nx-companion__title-row">
          <span className="nx-companion__wordmark">Nexus</span>
          <span className="nx-hint" style={{ marginLeft: 'auto' }}>
            Companion
          </span>
        </div>
      </header>
      <div className="nx-companion__body">
        <Stack>
          <p className="nx-hint">{reason}</p>

          {session === null ? (
            <>
              <Field label="Email" htmlFor="c-email" required>
                <TextInput
                  id="c-email"
                  value={email}
                  onChange={setEmail}
                  type="email"
                  autoComplete="username"
                />
              </Field>
              <Field label="Password" htmlFor="c-password" required>
                <TextInput
                  id="c-password"
                  value={password}
                  onChange={setPassword}
                  type="password"
                  autoComplete="current-password"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Channel account" htmlFor="c-identity" required>
                <Select
                  id="c-identity"
                  value={identityId}
                  onChange={setIdentityId}
                  placeholder={identities.length === 0 ? 'No channel account assigned to you' : undefined}
                  options={identities.map((identity) => ({
                    value: identity.id,
                    label: `${identity.displayName} (${identity.status})`,
                  }))}
                />
              </Field>
              <Field
                label="Default business"
                htmlFor="c-business"
                hint="Only the businesses this channel account may send from are listed."
              >
                <Select
                  id="c-business"
                  value={scope.businessId}
                  onChange={setDefaultBusinessId}
                  disabled={scope.eligible.length === 0}
                  placeholder={scope.eligible.length === 0 ? 'No business available' : undefined}
                  options={scope.eligible.map((business) => ({ value: business.id, label: business.name }))}
                />
              </Field>
              {/*
                The specific reason, not a generic permission message: the operator has
                to know whether the account is unassigned, or they are missing a grant.
              */}
              {!scope.canBind && (
                <Alert accent="amber" role="status">
                  {scope.message}
                </Alert>
              )}
            </>
          )}

          {error !== null && (
            <Alert accent="red" role="alert">
              {error}
            </Alert>
          )}

          {conflict !== null && (
            <Alert accent="amber" role="alert" title="This LinkedIn identity is currently active elsewhere">
              <Stack size="sm">
                {conflict.conflicts.map((holder) => (
                  <span key={holder.sessionId}>
                    Current operator: <strong>{holder.operatorName ?? 'another session'}</strong>
                    {holder.isSelf ? ' (another of your browser profiles)' : ''}
                    {' · '}
                    Last active: {holder.lastActiveAt.slice(0, 16).replace('T', ' ')}
                  </span>
                ))}
                <span className="nx-hint">
                  {conflict.canTransfer
                    ? 'Transferring signs the other browser profile out of this sender identity. It is recorded in the audit log.'
                    : 'Only an administrator can take an identity over. Ask an administrator to release it.'}
                </span>
                <Row>
                  <Button variant="secondary" size="sm" onClick={() => setConflict(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={!conflict.canTransfer}
                    onClick={() => void bind(true)}
                  >
                    Transfer to this browser
                  </Button>
                </Row>
              </Stack>
            </Alert>
          )}

          <Button
            variant="primary"
            block
            busy={busy}
            /*
              Disabled when there is nothing bindable — with the reason above it, not a
              generic permission sentence. Signing in is always available, because the
              scope is only known once the account is known.
            */
            disabled={session !== null && !scope.canBind}
            onClick={() => {
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  if (session === null) {
                    const result = await api.signIn(email, password);
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    await api.setToken(result.token);
                    const stored = await chrome.storage.local.get('nexus.installId');
                    await api.bootstrap(String(stored['nexus.installId'] ?? ''));
                    await onDone();
                    return;
                  }

                  if (identityId.length === 0) {
                    setError('Choose the channel account this browser profile uses.');
                    return;
                  }
                  if (!scope.canBind) {
                    setError(scope.message);
                    return;
                  }
                } finally {
                  setBusy(false);
                }
                // Binding runs outside the guard above so its own busy state covers the request.
                await bind(false);
              })();
            }}
          >
            {session === null ? 'Sign in' : 'Bind this browser'}
          </Button>

          <p className="nx-hint">
            Nexus is the system of record. This panel never sends anything on your behalf.
          </p>
        </Stack>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ lists ----- */

function LeadsPanel({
  leads,
  activeLeadId,
  busy,
  onOpen,
  onFindLinkedIn,
}: {
  readonly leads: readonly CompanionLead[];
  readonly activeLeadId: string | null;
  readonly busy: boolean;
  readonly onOpen: (leadId: string) => void;
  readonly onFindLinkedIn: (url: string) => void;
}): ReactElement {
  if (busy && leads.length === 0) return <span className="nx-hint">Loading leads…</span>;
  if (leads.length === 0) {
    return (
      <div className="nx-empty">
        <span className="nx-empty__title">No leads here</span>
        <p className="nx-empty__body">
          Adjust the business or ICP selector, or add a lead from Add to CRM.
        </p>
      </div>
    );
  }

  return (
    <ul className="nx-companion__list">
      {leads.map((lead) => (
        <li key={lead.id}>
          <CompanionLeadRow
            name={lead.personName}
            selected={lead.id === activeLeadId}
            meta={
              <>
                {lead.companyName ?? 'No company'}
                {lead.identityName === null ? '' : ` · ${lead.identityName}`}
              </>
            }
            action={
              <>
                <LeadStatusChip state={lead.status} />
                {lead.isDnc && <Chip accent="red">DNC</Chip>}
                {lead.needsProfile && <Chip accent="cyan">needs profile</Chip>}
                <EnrichmentChip status={lead.enrichmentStatus} intelligence={lead.intelligence} />
              </>
            }
            onClick={() => onOpen(lead.id)}
          />
          {/* Outside the row's button: an interactive element nested in a button is
              neither valid HTML nor reliably clickable. */}
          <FindLinkedInAction lead={lead} onFindLinkedIn={onFindLinkedIn} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The V1.2 enrichment indicator: pipeline state plus the intelligence percentage.
 *
 * Both values are the server's (`public.lead_enrichment`); the panel only labels them.
 */
function EnrichmentChip({
  status,
  intelligence,
}: {
  readonly status: string;
  readonly intelligence: number;
}): ReactElement {
  return (
    <>
      <Chip accent={enrichmentAccent(status)} title="Enrichment state">
        {enrichmentLabel(status)}
      </Chip>
      <Chip accent="indigo" title="Intelligence completeness">
        {intelligenceLabel(intelligence)}
      </Chip>
    </>
  );
}

/**
 * "Find LinkedIn" for a lead that has no profile URL yet.
 *
 * A lead captured minimally (name, company, location, source) lands in
 * `NEEDS_PROFILE`, and this is the next step the operator takes: a deterministic
 * Google search built by the server from exactly those fields. Nothing is rendered
 * when the server had too little to search for.
 */
function FindLinkedInAction({
  lead,
  onFindLinkedIn,
}: {
  readonly lead: {
    readonly needsProfile?: boolean;
    readonly linkedinUrl?: string | null;
    readonly enrichmentStatus?: string;
    readonly findLinkedInUrl?: string | null;
  };
  readonly onFindLinkedIn: (url: string) => void;
}): ReactElement | null {
  const url = lead.findLinkedInUrl ?? null;
  if (!needsFindLinkedIn(lead) || url === null) return null;

  return (
    <Row>
      <Button variant="ghost" size="sm" onClick={() => onFindLinkedIn(url)}>
        Find LinkedIn
      </Button>
    </Row>
  );
}

function TodayPanel({
  items,
  onOpen,
  onFindLinkedIn,
}: {
  readonly items: readonly CompanionTodayItem[];
  readonly selectedIndex: number;
  readonly onOpen: (leadId: string) => void;
  readonly onFindLinkedIn: (url: string) => void;
}): ReactElement {
  if (items.length === 0) {
    return (
      <div className="nx-empty">
        <span className="nx-empty__title">Nothing due</span>
        <p className="nx-empty__body">Acceptances, messages and follow-ups appear here when due.</p>
      </div>
    );
  }

  return (
    <ul className="nx-companion__list">
      {items.map((item) => (
        <li key={`${item.leadId}:${item.taskId ?? item.messageInstanceId ?? 'item'}`}>
          <CompanionLeadRow
            name={item.personName}
            meta={
              <>
                {item.companyName ?? 'No company'}
                {item.stepOrder !== null && item.stepOrder > 0
                  ? ` · ${item.stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(item.stepOrder - 1)}`}`
                  : ''}
              </>
            }
            action={
              <>
                <Chip accent={item.isOverdue ? 'red' : 'amber'}>{item.category.replace(/_/g, ' ')}</Chip>
                <DueChip dueAt={item.dueAt} overdue={item.isOverdue} />
                <EnrichmentChip status={item.enrichmentStatus} intelligence={item.intelligence} />
              </>
            }
            onClick={() => onOpen(item.leadId)}
          />
          <FindLinkedInAction
            lead={{
              enrichmentStatus: item.enrichmentStatus,
              findLinkedInUrl: item.findLinkedInUrl,
            }}
            onFindLinkedIn={onFindLinkedIn}
          />
        </li>
      ))}
    </ul>
  );
}

function SearchPanel({
  results,
  busy,
  onSearch,
  onOpen,
  onFindLinkedIn,
}: {
  readonly results: readonly SearchResult[];
  readonly busy: boolean;
  readonly onSearch: (query: string) => Promise<void>;
  readonly onOpen: (leadId: string) => void;
  readonly onFindLinkedIn: (url: string) => void;
}): ReactElement {
  const [query, setQuery] = useState('');

  return (
    <Stack size="sm">
      <Row>
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder="LinkedIn URL, name or company"
          ariaLabel="Search Nexus"
        />
        <Button variant="primary" size="sm" busy={busy} onClick={() => void onSearch(query)}>
          Search
        </Button>
      </Row>

      {results.length === 0 ? (
        <span className="nx-hint">
          Search every business you can access. A person with several business contexts is shown
          once per business so you choose the right record.
        </span>
      ) : (
        <ul className="nx-companion__list">
          {results.map((result) => (
            <li key={`${result.leadId}`}>
              <CompanionLeadRow
                name={result.personName}
                meta={
                  <>
                    {result.companyName ?? 'No company'} · {result.businessName}
                  </>
                }
                action={
                  <>
                    <LeadStatusChip state={result.status} />
                    {result.nextActionAt !== null && (
                      <span className="nx-hint">next {result.nextActionAt.slice(0, 10)}</span>
                    )}
                    <EnrichmentChip status={result.enrichmentStatus} intelligence={result.intelligence} />
                  </>
                }
                onClick={() => onOpen(result.leadId)}
              />
              <FindLinkedInAction
                lead={{ linkedinUrl: null, enrichmentStatus: result.enrichmentStatus, findLinkedInUrl: result.findLinkedInUrl }}
                onFindLinkedIn={onFindLinkedIn}
              />
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}

/* --------------------------------------------------------- add to CRM --- */

function AddToCrm({
  businesses,
  icps,
  businessId,
  icpId,
  identityId,
  busy,
  onError,
  onCreated,
}: {
  readonly businesses: readonly CompanionBusiness[];
  readonly icps: readonly CompanionIcp[];
  readonly businessId: string;
  readonly icpId: string;
  readonly identityId: string;
  readonly busy: boolean;
  readonly onError: (message: string) => void;
  readonly onCreated: (leadId: string) => void;
}): ReactElement {
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [autoMatch, setAutoMatch] = useState(icpId.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /**
   * The V1.2 minimal-lead fields (spec `minimalLeadInputSchema`).
   *
   * A lead is accepted the moment anything is known about it, so these are the whole
   * payload for the second capture shape: person name plus company and location, with
   * an optional title/headline/snippet. Nothing is invented for a field left empty —
   * the server records what it has and puts the lead in `NEEDS_PROFILE`, which is what
   * makes "Find LinkedIn" available for it afterwards.
   */
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [location, setLocation] = useState('');
  const [source, setSource] = useState('companion');
  const [jobTitle, setJobTitle] = useState('');
  const [headline, setHeadline] = useState('');
  const [snippet, setSnippet] = useState('');
  /** What the content script could read, shown back so the operator sees it before submitting. */
  const [extracted, setExtracted] = useState<{
    readonly headline: string | null;
    readonly jobTitle: string | null;
    readonly company: string | null;
  } | null>(null);

  const hasProfileUrl = url.trim().length > 0;
  const canSubmit = hasProfileUrl || fullName.trim().length > 0;

  return (
    <Stack size="sm">
      <Field
        label="LinkedIn profile URL"
        htmlFor="add-url"
        hint="Optional in V1.2: a lead can be added from a name alone."
      >
        <TextInput id="add-url" value={url} onChange={setUrl} type="url" />
      </Field>

      <Row>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void (async () => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (tab?.id === undefined) {
                setError('No browser tab is active. Open the LinkedIn profile in a tab, then capture it.');
                return;
              }
              try {
                // A content script's reply is untrusted input, so it is narrowed rather than
                // asserted: an unexpected shape must not crash the panel, and a page that is not a
                // profile must produce the documented fallback rather than a partial record.
                const reply: unknown = await chrome.tabs.sendMessage(tab.id, {
                  type: 'nexus:capture-page',
                });
                if (typeof reply !== 'object' || reply === null) {
                  setError('The page did not return a profile. Paste the profile text below instead.');
                  return;
                }
                const captured = reply as {
                  available?: unknown;
                  reason?: unknown;
                  url?: unknown;
                  headline?: unknown;
                  jobTitle?: unknown;
                  company?: unknown;
                  capturedText?: unknown;
                };

                if (captured.available !== true) {
                  setError(
                    typeof captured.reason === 'string'
                      ? captured.reason
                      : 'This page did not look like a LinkedIn profile. Paste the profile text below instead.',
                  );
                  return;
                }

                if (typeof captured.url === 'string') setUrl(captured.url);
                if (typeof captured.capturedText === 'string') setContent(captured.capturedText);
                // The fields the adapter could read are shown so the operator can see what will be
                // captured; they remain editable, and a missing one is left for the paste.
                setExtracted({
                  headline: typeof captured.headline === 'string' ? captured.headline : null,
                  jobTitle: typeof captured.jobTitle === 'string' ? captured.jobTitle : null,
                  company: typeof captured.company === 'string' ? captured.company : null,
                });
                setError(null);
              } catch {
                setError('Open the LinkedIn profile in this tab first, then capture it.');
              }
            })();
          }}
        >
          Capture this page
        </Button>
      </Row>

      {extracted !== null && (
        <p className="nx-hint" role="status">
          Read from the page: {extracted.jobTitle ?? 'no job title'}
          {extracted.company === null ? '' : ` at ${extracted.company}`}
          {extracted.headline === null ? '' : ` \u00b7 ${extracted.headline}`}
        </p>
      )}

      <Field
        label="Copied profile content"
        htmlFor="add-content"
        hint="Paste the full profile text. It is stored as source evidence, never executed."
      >
        <TextArea id="add-content" value={content} onChange={setContent} tall />
      </Field>

      <Row>
        <label className="nx-label" htmlFor="add-automatch">
          <input
            id="add-automatch"
            type="checkbox"
            checked={autoMatch}
            onChange={(event) => setAutoMatch(event.target.checked)}
          />{' '}
          Auto-match the Primary ICP
        </label>
      </Row>

      {!autoMatch && (
        <Field label="Primary ICP" htmlFor="add-icp" required>
          <Select
            id="add-icp"
            value={icpId}
            onChange={() => undefined}
            placeholder="Choose an ICP"
            options={icps.map((icp) => ({ value: icp.id, label: icp.name }))}
          />
        </Field>
      )}

      <p className="nx-hint">
        Deduplication runs before a lead is created. If this person already has a lead in{' '}
        {businesses.find((b) => b.id === businessId)?.name ?? 'this business'}, the existing record
        is updated instead. Partial records are marked Needs profile.
      </p>

      {/*
        The minimal-lead fields. A capture with only a name (and whatever else the
        operator happens to know) is a legitimate lead in V1.2, so this section is
        always available rather than hidden behind a mode switch.
      */}
      <div className="nx-overline">Or add a minimal lead</div>
      <Field label="Person name" htmlFor="add-name" hint="Required when there is no profile URL.">
        <TextInput id="add-name" value={fullName} onChange={setFullName} />
      </Field>
      <Row>
        <Field label="Company" htmlFor="add-company">
          <TextInput id="add-company" value={companyName} onChange={setCompanyName} />
        </Field>
        <Field label="Location" htmlFor="add-location">
          <TextInput id="add-location" value={location} onChange={setLocation} />
        </Field>
      </Row>
      <Row>
        <Field label="Job title (optional)" htmlFor="add-title">
          <TextInput id="add-title" value={jobTitle} onChange={setJobTitle} />
        </Field>
        <Field label="Source" htmlFor="add-source" hint="Where this lead was found.">
          <TextInput id="add-source" value={source} onChange={setSource} />
        </Field>
      </Row>
      <Field label="Headline (optional)" htmlFor="add-headline">
        <TextInput id="add-headline" value={headline} onChange={setHeadline} />
      </Field>
      <Field label="Snippet (optional)" htmlFor="add-snippet" hint="Kept as the source evidence for this capture.">
        <TextArea id="add-snippet" value={snippet} onChange={setSnippet} />
      </Field>

      {error !== null && (
        <Alert accent="red" role="alert">
          {error}
        </Alert>
      )}

      <Button
        variant="primary"
        block
        busy={busy || working}
        disabled={!canSubmit}
        title={canSubmit ? undefined : 'Enter a LinkedIn profile URL or at least the person name.'}
        onClick={() => {
          void (async () => {
            if (!canSubmit) {
              setError('Enter a LinkedIn profile URL, or at least the person name, so nothing has to be invented.');
              return;
            }
            setWorking(true);
            setError(null);
            try {
              /**
               * One payload, whichever shape the operator filled in.
               *
               * The idempotency key is derived from what actually identifies the capture
               * — the profile URL, or the name/company pair — so retrying the same
               * capture is a replay and a different one is a new ingestion.
               */
              const identity = hasProfileUrl ? url.trim() : `${fullName.trim()}|${companyName.trim()}`;
              const result = await api.addToCrm({
                linkedinUrl: hasProfileUrl ? url : undefined,
                pastedContent: content,
                businessId,
                icpId: autoMatch ? null : icpId,
                autoMatch,
                identityId,
                fullName: fullName.trim().length === 0 ? undefined : fullName.trim(),
                companyName: companyName.trim().length === 0 ? undefined : companyName.trim(),
                location: location.trim().length === 0 ? undefined : location.trim(),
                source: source.trim().length === 0 ? undefined : source.trim(),
                jobTitle: jobTitle.trim().length === 0 ? undefined : jobTitle.trim(),
                headline: headline.trim().length === 0 ? undefined : headline.trim(),
                snippet: snippet.trim().length === 0 ? undefined : snippet.trim(),
                idempotencyKey: `companion:${identity}:${String(content.length)}:${String(snippet.length)}`.slice(0, 200),
              });
              if (!result.ok) {
                setError(result.error);
                onError(result.error);
                return;
              }
              onCreated(result.leadId);
            } finally {
              setWorking(false);
            }
          })();
        }}
      >
        Add to Nexus
      </Button>
    </Stack>
  );
}

/* ------------------------------------------------------- action focus --- */

function ActionFocus({
  detail,
  identityId,
  busy,
  onOpenLinkedIn,
  onFindLinkedIn,
  onMarkConnection,
  onMarkMessageSent,
  onSnooze,
  onCaptureReply,
  onReactivate,
  onBack,
}: {
  readonly detail: CompanionLeadDetail;
  readonly identityId: string;
  readonly busy: boolean;
  readonly onOpenLinkedIn: () => void;
  readonly onFindLinkedIn: (url: string) => void;
  readonly onMarkConnection: (withNote: boolean) => void;
  readonly onMarkMessageSent: () => void;
  readonly onSnooze: (until: string) => void;
  readonly onCaptureReply: () => void;
  readonly onReactivate: () => void;
  readonly onBack: () => void;
}): ReactElement {
  const { lead, currentMessage, recentHistory, sequence } = detail;
  const isConnectionStep = currentMessage === null || currentMessage.stepOrder === 0;
  const dormant = sequence.state === 'dormant' || sequence.state === 'reactivation_due';

  return (
    <Stack size="sm">
      <Row between>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <Row>
          <LeadStatusChip state={lead.status} />
          {lead.isDnc && <Chip accent="red">DNC</Chip>}
        </Row>
      </Row>

      <div className="nx-lead-row__name">{lead.personName}</div>
      <div className="nx-lead-row__meta">
        {lead.companyName ?? 'No company'}
        {lead.jobTitle === null ? '' : ` · ${lead.jobTitle}`}
      </div>

      {/* The enrichment indicator on the record the operator is about to act on. */}
      <Row between>
        <span className="nx-hint">Enrichment</span>
        <EnrichmentChip status={lead.enrichmentStatus} intelligence={lead.intelligence} />
      </Row>

      {lead.isDnc && (
        <Alert accent="red" role="alert">
          Do Not Contact. Suppressed on every sender identity — do not contact from another account.
        </Alert>
      )}

      {lead.linkedinUrl !== null && (
        <Button variant="secondary" block onClick={onOpenLinkedIn}>
          Open LinkedIn profile
        </Button>
      )}

      {/* The minimal-lead fallback: this lead has no profile URL yet, so the next step
          is the deterministic search the server generated for it. */}
      <FindLinkedInAction lead={lead} onFindLinkedIn={onFindLinkedIn} />

      {/* Sender identity and CRM owner are separate dimensions
          (spec `identity_model.outreach_identity.rule`), so the sender is shown
          explicitly rather than implied by the panel's selector. */}
      <Row between>
        <span className="nx-hint">Sending as</span>
        <Chip accent="indigo">
          {lead.identityName ?? (identityId.length > 0 ? 'selected sender' : 'no sender bound')}
        </Chip>
      </Row>

      {dormant ? (
        <Stack size="sm">
          <Alert accent="amber">
            Dormant. Review{' '}
            {sequence.reactivationDueAt === null
              ? 'when a fresh signal appears'
              : `from ${sequence.reactivationDueAt.slice(0, 10)}`}
            .
          </Alert>
          <Button variant="primary" block busy={busy} onClick={onReactivate}>
            Open reactivation
          </Button>
        </Stack>
      ) : isConnectionStep ? (
        <Stack size="sm">
          <div className="nx-action-badge">Connection</div>
          <p className="nx-hint">
            Send the invitation from LinkedIn, then record it here. Nexus never sends for you.
          </p>
          <Button variant="primary" block busy={busy} onClick={() => onMarkConnection(true)}>
            Mark sent with note
          </Button>
          <Button variant="secondary" block busy={busy} onClick={() => onMarkConnection(false)}>
            Mark sent without note
          </Button>
        </Stack>
      ) : (
        <Stack size="sm">
          <Row between>
            <div className="nx-action-badge">
              {currentMessage.stepOrder <= 1
                ? 'Message 1'
                : `Follow-up ${String(currentMessage.stepOrder - 1)}`}
            </div>
            <MessageStateChip state={currentMessage.state} />
          </Row>

          <MessageBlock
            direction="outbound"
            immutable={currentMessage.state === 'SENT'}
            meta={
              <span>
                {currentMessage.state === 'SENT'
                  ? `sent ${currentMessage.sentAt?.slice(0, 16) ?? ''}`
                  : 'editable before sending'}
              </span>
            }
          >
            {currentMessage.content ?? 'Not generated yet.'}
          </MessageBlock>

          {currentMessage.state === 'SENT' ? (
            <Chip accent="green">Immutable — corrections are new events, never overwrites</Chip>
          ) : (
            <Button variant="primary" block busy={busy} onClick={onMarkMessageSent}>
              Mark sent
            </Button>
          )}
        </Stack>
      )}

      <Row>
        <Button
          variant="ghost"
          size="sm"
          busy={busy}
          onClick={() => {
            const tomorrow = new Date(Date.now() + 86_400_000);
            onSnooze(tomorrow.toISOString());
          }}
        >
          Snooze 1 day
        </Button>
        <Button variant="ghost" size="sm" onClick={onCaptureReply}>
          Capture reply
        </Button>
      </Row>

      {/* Compact recent history only — spec `followup_focus`: "Do not show every
          message expanded." */}
      <div className="nx-overline">Recent history</div>
      <Stack size="sm">
        {recentHistory.slice(0, 3).map((entry) => (
          <MessageBlock key={entry.id} direction="inbound" compact>
            {entry.body ?? entry.summary ?? ''}
          </MessageBlock>
        ))}
        {recentHistory.length === 0 && <span className="nx-hint">No history yet.</span>}
      </Stack>
    </Stack>
  );
}

/* -------------------------------------------------------- reply (U29) --- */

function ReplyAndNotes({
  detail,
  busy,
  onBack,
  onSave,
}: {
  readonly detail: CompanionLeadDetail;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onSave: (exactText: string, outcome: string, note: string | null) => void;
}): ReactElement {
  const [exactText, setExactText] = useState('');
  const [outcome, setOutcome] = useState<string>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <Stack size="sm">
      <Row between>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <div className="nx-lead-row__name">{detail.lead.personName}</div>
      </Row>

      <Field
        label="Exact reply"
        htmlFor="reply-exact"
        required
        hint="Paste the reply word for word. It is stored verbatim and never re-worded."
      >
        <TextArea id="reply-exact" value={exactText} onChange={setExactText} tall />
      </Field>

      <Field label="Outcome" htmlFor="reply-outcome" required>
        <Select
          id="reply-outcome"
          value={outcome}
          onChange={setOutcome}
          placeholder="Choose an outcome"
          options={REPLY_OUTCOMES.map((value) => ({ value, label: value }))}
        />
      </Field>

      <Field label="Internal note" htmlFor="reply-note" hint="Kept separate; never sent to the prospect.">
        <TextArea id="reply-note" value={note} onChange={setNote} />
      </Field>

      <p className="nx-hint">
        Saving pauses pending sequence steps. An explicit &ldquo;Do not contact&rdquo; suppresses this
        person on every identity.
      </p>

      {error !== null && (
        <Alert accent="red" role="alert">
          {error}
        </Alert>
      )}

      <Button
        variant="primary"
        block
        busy={busy}
        onClick={() => {
          if (exactText.trim().length === 0 || outcome.length === 0) {
            setError('Paste the exact reply and choose an outcome.');
            return;
          }
          setError(null);
          onSave(exactText, outcome, note.trim().length === 0 ? null : note);
        }}
      >
        Save reply
      </Button>
    </Stack>
  );
}

/* ---------------------------------------------------- reactivation (U30) */

function ReactivationFocus({
  detail,
  busy,
  onBack,
  onStart,
}: {
  readonly detail: CompanionLeadDetail;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onStart: () => void;
}): ReactElement {
  const { sequence, recentHistory } = detail;

  return (
    <Stack size="sm">
      <Row between>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <div className="nx-lead-row__name">{detail.lead.personName}</div>
      </Row>

      <Alert accent="amber">
        Dormant since {sequence.dormantAt?.slice(0, 10) ?? 'unknown'}. Review{' '}
        {sequence.reactivationDueAt === null ? 'pending' : sequence.reactivationDueAt.slice(0, 10)}.
      </Alert>

      <div className="nx-overline">Previous outreach</div>
      <Stack size="sm">
        {sequence.priorSteps.map((step) => (
          <Row key={step.stepOrder} between>
            <span>
              {step.stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(step.stepOrder - 1)}`}
            </span>
            <span className="nx-hint">{step.sentAt?.slice(0, 10) ?? 'not sent'}</span>
          </Row>
        ))}
        {sequence.priorSteps.length === 0 && <span className="nx-hint">No steps were sent.</span>}
      </Stack>

      <div className="nx-overline">Earlier context</div>
      <Stack size="sm">
        {recentHistory.slice(0, 2).map((entry) => (
          <MessageBlock key={entry.id} direction="inbound" compact>
            {entry.body ?? entry.summary ?? ''}
          </MessageBlock>
        ))}
      </Stack>

      <p className="nx-hint">
        Use a new angle and fresh evidence. Do not repeat the previous sequence.
      </p>

      <Button variant="primary" block busy={busy} onClick={onStart}>
        Open reactivation
      </Button>
    </Stack>
  );
}
