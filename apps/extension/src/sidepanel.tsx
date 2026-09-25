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
import { clearSession, openInActiveTab } from './chrome-actions';
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
import { useListState } from './use-list-state';

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

  // Default the selectors from the binding / first available option.
  useEffect(() => {
    if (!listState.ready) return;
    if (businessId.length === 0) {
      const fallback = binding?.defaultBusinessId ?? businesses[0]?.id ?? '';
      if (fallback.length > 0) listState.update({ businessId: fallback });
      return;
    }
    if (identityId.length === 0) {
      const fallback = binding?.identityId ?? identities[0]?.id ?? '';
      if (fallback.length > 0) listState.update({ identityId: fallback });
    }
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
      businesses={businesses.map((business) => ({ value: business.id, label: business.name }))}
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
          businesses={businesses}
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
        />
      ) : module === 'today' ? (
        <TodayPanel
          items={todayItems}
          selectedIndex={selectedIndex}
          onOpen={(leadId) => void openLead(leadId, 'focus')}
        />
      ) : (
        <LeadsPanel
          leads={leads}
          activeLeadId={activeLeadId}
          busy={busy}
          onOpen={(leadId) => void openLead(leadId, 'focus')}
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
  const [defaultBusinessId, setDefaultBusinessId] = useState(businesses[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
        defaultBusinessId: defaultBusinessId.length === 0 ? null : defaultBusinessId,
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
              <Field label="LinkedIn identity" htmlFor="c-identity" required>
                <Select
                  id="c-identity"
                  value={identityId}
                  onChange={setIdentityId}
                  placeholder={identities.length === 0 ? 'No identity assigned to you' : undefined}
                  options={identities.map((identity) => ({
                    value: identity.id,
                    label: `${identity.displayName} (${identity.status})`,
                  }))}
                />
              </Field>
              <Field label="Default business" htmlFor="c-business">
                <Select
                  id="c-business"
                  value={defaultBusinessId}
                  onChange={setDefaultBusinessId}
                  placeholder="Choose a business"
                  options={businesses.map((business) => ({ value: business.id, label: business.name }))}
                />
              </Field>
              <p className="nx-hint">
                Visible businesses are the ones your account can access intersected with this
                identity&apos;s business access.
              </p>
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
                    setError('Choose the identity this browser profile uses.');
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
}: {
  readonly leads: readonly CompanionLead[];
  readonly activeLeadId: string | null;
  readonly busy: boolean;
  readonly onOpen: (leadId: string) => void;
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
              </>
            }
            onClick={() => onOpen(lead.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function TodayPanel({
  items,
  onOpen,
}: {
  readonly items: readonly CompanionTodayItem[];
  readonly selectedIndex: number;
  readonly onOpen: (leadId: string) => void;
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
              </>
            }
            onClick={() => onOpen(item.leadId)}
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
}: {
  readonly results: readonly SearchResult[];
  readonly busy: boolean;
  readonly onSearch: (query: string) => Promise<void>;
  readonly onOpen: (leadId: string) => void;
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
                  </>
                }
                onClick={() => onOpen(result.leadId)}
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
  /** What the content script could read, shown back so the operator sees it before submitting. */
  const [extracted, setExtracted] = useState<{
    readonly headline: string | null;
    readonly jobTitle: string | null;
    readonly company: string | null;
  } | null>(null);

  return (
    <Stack size="sm">
      <Field label="LinkedIn profile URL" htmlFor="add-url" required>
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
        required
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

      {error !== null && (
        <Alert accent="red" role="alert">
          {error}
        </Alert>
      )}

      <Button
        variant="primary"
        block
        busy={busy || working}
        onClick={() => {
          void (async () => {
            setWorking(true);
            setError(null);
            try {
              const result = await api.addToCrm({
                linkedinUrl: url,
                pastedContent: content,
                businessId,
                icpId: autoMatch ? null : icpId,
                autoMatch,
                identityId,
                // Idempotency: retrying the same capture must not create a second lead.
                idempotencyKey: `companion:${url}:${String(content.length)}`,
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
