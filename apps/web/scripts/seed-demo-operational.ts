/**
 * Operational half of the development / visual-QA seed.
 *
 * `seed-demo.ts` puts the *configuration* in place (businesses, users, ICPs, sequences,
 * identities, knowledge). That is enough to render setup screens, but every operational
 * screen — My Day, Leads, Lead Detail, Profile Queue, Lead Sources, Duplicates, Insights —
 * branches on rows. With none, they render their empty state and cannot be visually
 * reviewed at all, which is exactly the failure mode the UI fidelity pass has to avoid.
 *
 * This module adds the rows: companies, people, leads covering every status the
 * `leads_status_check` constraint allows, ICP matches, tasks (including overdue and done),
 * notes, exact inbound replies with conversation outcomes, sequence enrollments, sent
 * message instances, import batches with per-row outcomes, duplicate candidates, profile
 * queue items, automations and agent runs.
 *
 * Every row is written through the real tables, so the invariant triggers and CHECK
 * constraints are the acceptance test: if this script produced an impossible state, the
 * database would refuse it rather than let the UI render a state the product can never be
 * in.
 */
import type { PGlite } from '@electric-sql/pglite';

export interface OperationalSeedIds {
  readonly adminId: string;
  readonly managerId: string;
  readonly osamaId: string;
  readonly bismaId: string;
  readonly zemnas: string;
  readonly lavish: string;
  readonly ai: string;
  readonly icpMedia: string;
  readonly icpAgency: string;
  readonly icpExport: string;
  readonly icpGcc: string;
  readonly seqZemnas: string;
  readonly seqVerZemnas: string;
  readonly identityOsama: string;
  readonly identityBisma: string;
  readonly identityJames: string;
}

/** Deterministic ids so a re-run is idempotent and screenshots stay comparable. */
const id = (group: string, n: number): string =>
  `${group.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const OP_IDS = {
  company: (n: number) => id('d0000010', n),
  person: (n: number) => id('d0000011', n),
  lead: (n: number) => id('d0000012', n),
  note: (n: number) => id('d0000013', n),
  task: (n: number) => id('d0000014', n),
  interaction: (n: number) => id('d0000015', n),
  conversation: (n: number) => id('d0000016', n),
  outcome: (n: number) => id('d0000017', n),
  enrollment: (n: number) => id('d0000018', n),
  message: (n: number) => id('d0000019', n),
  messageVersion: (n: number) => id('d0000020', n),
  batch: (n: number) => id('d0000021', n),
  queue: (n: number) => id('d0000022', n),
  duplicate: (n: number) => id('d0000023', n),
  automation: (n: number) => id('d0000024', n),
  agentRun: (n: number) => id('d0000025', n),
  signal: (n: number) => id('d0000026', n),
  evidence: (n: number) => id('d0000027', n),
  savedView: (n: number) => id('d0000028', n),
} as const;

/**
 * The spec's permitted demo people and companies (`seed_and_demo_policy`), expanded to the
 * size a real screen needs. Nothing here is invented outside those lists.
 */
const COMPANIES: readonly {
  readonly name: string;
  readonly domain: string;
  readonly industry: string;
  readonly employees: number;
  readonly country: string;
}[] = [
  { name: 'ABC Media', domain: 'abcmedia.example', industry: 'Media', employees: 240, country: 'GB' },
  { name: 'Frame House', domain: 'framehouse.example', industry: 'Post-production', employees: 85, country: 'US' },
  { name: 'Kite Studio', domain: 'kitestudio.example', industry: 'Creative agency', employees: 42, country: 'US' },
  { name: 'Northstar', domain: 'northstar.example', industry: 'Advertising', employees: 520, country: 'DE' },
  { name: 'Nova Haus', domain: 'novahaus.example', industry: 'Brand studio', employees: 31, country: 'DE' },
  { name: 'Studio 8', domain: 'studio8.example', industry: 'Video production', employees: 64, country: 'GB' },
  { name: 'Rhine Distributors', domain: 'rhine-dist.example', industry: 'Food distribution', employees: 310, country: 'DE' },
  { name: 'Berlin Retail Group', domain: 'berlinretail.example', industry: 'Retail', employees: 1400, country: 'DE' },
  { name: 'Gulf Systems', domain: 'gulfsystems.example', industry: 'Enterprise IT', employees: 900, country: 'AE' },
  { name: 'Riyadh Holding', domain: 'riyadhholding.example', industry: 'Conglomerate', employees: 2400, country: 'SA' },
  { name: 'Talent Bridge', domain: 'talentbridge.example', industry: 'Recruitment', employees: 55, country: 'GB' },
  { name: 'Everafter Films', domain: 'everafterfilms.example', industry: 'Wedding film', employees: 12, country: 'US' },
];

const PEOPLE: readonly {
  readonly name: string;
  readonly title: string;
  readonly company: number;
  readonly location: string;
}[] = [
  { name: 'Tom Henry', title: 'Head of Production', company: 1, location: 'London, UK' },
  { name: 'Sarah Smith', title: 'Content Lead', company: 1, location: 'Manchester, UK' },
  { name: 'Mia Becker', title: 'Creative Director', company: 3, location: 'Austin, US' },
  { name: 'Jon Davies', title: 'Producer', company: 2, location: 'New York, US' },
  { name: 'Nora Schmidt', title: 'Marketing Director', company: 4, location: 'Berlin, DE' },
  { name: 'Lisa Weber', title: 'Head of Brand', company: 5, location: 'Munich, DE' },
  { name: 'Owen Clarke', title: 'Managing Director', company: 6, location: 'Bristol, UK' },
  { name: 'Priya Nair', title: 'Procurement Lead', company: 7, location: 'Cologne, DE' },
  { name: 'Klaus Vogel', title: 'Category Manager', company: 8, location: 'Hamburg, DE' },
  { name: 'Amir Haddad', title: 'CTO', company: 9, location: 'Dubai, AE' },
  { name: 'Layla Mansour', title: 'Head of Digital', company: 10, location: 'Riyadh, SA' },
  { name: 'Grace Bennett', title: 'Recruitment Consultant', company: 11, location: 'Leeds, UK' },
  { name: 'Danielle Fox', title: 'Owner', company: 12, location: 'Denver, US' },
  { name: 'Marcus Reed', title: 'Executive Producer', company: 2, location: 'Los Angeles, US' },
  { name: 'Hannah Cole', title: 'Social Media Manager', company: 3, location: 'Chicago, US' },
  { name: 'Kenji Watanabe', title: 'Head of Content', company: 6, location: 'Tokyo, JP' },
  { name: 'Ines Moreau', title: 'Brand Manager', company: 5, location: 'Paris, FR' },
  { name: 'Tobias Klein', title: 'Operations Director', company: 7, location: 'Dusseldorf, DE' },
  { name: 'Sara Lindqvist', title: 'Head of Growth', company: 4, location: 'Stockholm, SE' },
  { name: 'Rashid Al Nuaimi', title: 'IT Director', company: 9, location: 'Abu Dhabi, AE' },
  { name: 'Fatima Zahra', title: 'Digital Transformation Lead', company: 10, location: 'Jeddah, SA' },
  { name: 'Peter Novak', title: 'Supply Chain Manager', company: 8, location: 'Vienna, AT' },
  { name: 'Elena Rossi', title: 'Head of Video', company: 1, location: 'Milan, IT' },
  { name: 'Chris Palmer', title: 'Founder', company: 12, location: 'Phoenix, US' },
  { name: 'Aisha Karim', title: 'Brand Partnerships Lead', company: 4, location: 'Berlin, DE' },
  { name: 'David Okafor', title: 'Head of Video Production', company: 6, location: 'Leeds, UK' },
  { name: 'Mei Lin', title: 'Content Strategy Lead', company: 2, location: 'Singapore, SG' },
  { name: 'Robert Fischer', title: 'Head of Procurement', company: 7, location: 'Stuttgart, DE' },
  { name: 'Clara Jensen', title: 'Marketing Manager', company: 5, location: 'Copenhagen, DK' },
  { name: 'Omar Farouk', title: 'Head of Infrastructure', company: 9, location: 'Dubai, AE' },
  { name: 'Julia Brandt', title: 'Head of Retail Marketing', company: 8, location: 'Berlin, DE' },
  { name: 'Simon Wright', title: 'Executive Creative Director', company: 3, location: 'Portland, US' },
  { name: 'Nadia Haddad', title: 'Head of Data', company: 10, location: 'Riyadh, SA' },
  { name: 'Victor Alvarez', title: 'Post Supervisor', company: 2, location: 'Madrid, ES' },
];

type LeadStatus =
  | 'new'
  | 'needs_profile'
  | 'ready'
  | 'connection_due'
  | 'connection_sent'
  | 'connection_accepted'
  | 'message_due'
  | 'followup_due'
  | 'replied'
  | 'paused'
  | 'cooldown'
  | 'dormant'
  | 'reactivation_due'
  | 'interested'
  | 'wrong_person'
  | 'do_not_contact'
  | 'archived';

interface LeadSpec {
  readonly person: number;
  readonly business: 'zemnas' | 'lavish' | 'ai';
  readonly icp: 'media' | 'agency' | 'export' | 'gcc';
  readonly status: LeadStatus;
  readonly nextAction: string;
  readonly nextActionInDays: number | null;
  readonly owner: 'admin' | 'manager' | 'osama' | 'bisma';
  readonly source: string;
  readonly needsProfile: boolean;
  readonly dnc: boolean;
  readonly score: number | null;
}

/**
 * Every status in `leads_status_check` appears at least once, because a status that no row
 * can reach is a status whose rendering has never been looked at.
 */
const LEADS: readonly LeadSpec[] = [
  { person: 1, business: 'zemnas', icp: 'media', status: 'new', nextAction: 'capture_profile', nextActionInDays: null, owner: 'osama', source: 'paste_list', needsProfile: false, dnc: false, score: 72 },
  { person: 2, business: 'zemnas', icp: 'media', status: 'needs_profile', nextAction: 'capture_profile', nextActionInDays: 0, owner: 'osama', source: 'google_search', needsProfile: true, dnc: false, score: null },
  { person: 3, business: 'zemnas', icp: 'agency', status: 'ready', nextAction: 'connection', nextActionInDays: 0, owner: 'osama', source: 'file_csv', needsProfile: false, dnc: false, score: 88 },
  { person: 4, business: 'zemnas', icp: 'media', status: 'connection_due', nextAction: 'connection', nextActionInDays: 0, owner: 'osama', source: 'manual_add', needsProfile: false, dnc: false, score: 64 },
  { person: 5, business: 'zemnas', icp: 'agency', status: 'connection_sent', nextAction: 'review', nextActionInDays: 2, owner: 'osama', source: 'apollo_basic', needsProfile: false, dnc: false, score: 55 },
  { person: 6, business: 'zemnas', icp: 'media', status: 'connection_accepted', nextAction: 'message_1', nextActionInDays: 0, owner: 'osama', source: 'external_ingest', needsProfile: false, dnc: false, score: 81 },
  { person: 7, business: 'zemnas', icp: 'media', status: 'message_due', nextAction: 'message_1', nextActionInDays: 0, owner: 'osama', source: 'mcp_agent', needsProfile: false, dnc: false, score: 77 },
  { person: 8, business: 'zemnas', icp: 'agency', status: 'followup_due', nextAction: 'followup_1', nextActionInDays: 0, owner: 'osama', source: 'paste_list', needsProfile: false, dnc: false, score: 69 },
  { person: 9, business: 'zemnas', icp: 'media', status: 'followup_due', nextAction: 'followup_2', nextActionInDays: -1, owner: 'osama', source: 'file_xlsx', needsProfile: false, dnc: false, score: 58 },
  { person: 10, business: 'zemnas', icp: 'agency', status: 'replied', nextAction: 'review', nextActionInDays: -2, owner: 'osama', source: 'research_agent', needsProfile: false, dnc: false, score: 91 },
  { person: 11, business: 'zemnas', icp: 'media', status: 'interested', nextAction: 'task', nextActionInDays: 1, owner: 'manager', source: 'manual_companion', needsProfile: false, dnc: false, score: 95 },
  { person: 12, business: 'zemnas', icp: 'media', status: 'paused', nextAction: 'none', nextActionInDays: null, owner: 'osama', source: 'paste_list', needsProfile: false, dnc: false, score: 40 },
  { person: 13, business: 'zemnas', icp: 'agency', status: 'cooldown', nextAction: 'reactivation', nextActionInDays: 21, owner: 'osama', source: 'file_csv', needsProfile: false, dnc: false, score: 33 },
  { person: 14, business: 'zemnas', icp: 'media', status: 'dormant', nextAction: 'reactivation', nextActionInDays: 45, owner: 'osama', source: 'google_search', needsProfile: false, dnc: false, score: 47 },
  { person: 15, business: 'zemnas', icp: 'media', status: 'reactivation_due', nextAction: 'reactivation', nextActionInDays: 0, owner: 'osama', source: 'apollo_basic', needsProfile: false, dnc: false, score: 52 },
  { person: 16, business: 'zemnas', icp: 'agency', status: 'wrong_person', nextAction: 'none', nextActionInDays: null, owner: 'osama', source: 'paste_list', needsProfile: false, dnc: false, score: 18 },
  { person: 17, business: 'zemnas', icp: 'media', status: 'do_not_contact', nextAction: 'none', nextActionInDays: null, owner: 'osama', source: 'file_csv', needsProfile: false, dnc: true, score: 12 },
  { person: 18, business: 'zemnas', icp: 'media', status: 'archived', nextAction: 'none', nextActionInDays: null, owner: 'osama', source: 'paste_list', needsProfile: false, dnc: false, score: 25 },
  { person: 19, business: 'zemnas', icp: 'agency', status: 'needs_profile', nextAction: 'capture_profile', nextActionInDays: 0, owner: 'osama', source: 'google_search', needsProfile: true, dnc: false, score: null },
  { person: 20, business: 'zemnas', icp: 'agency', status: 'followup_due', nextAction: 'followup_3', nextActionInDays: -3, owner: 'bisma', source: 'file_csv', needsProfile: false, dnc: false, score: 61 },
  { person: 21, business: 'lavish', icp: 'export', status: 'ready', nextAction: 'connection', nextActionInDays: 0, owner: 'bisma', source: 'file_xlsx', needsProfile: false, dnc: false, score: 70 },
  { person: 22, business: 'lavish', icp: 'export', status: 'message_due', nextAction: 'message_1', nextActionInDays: 0, owner: 'bisma', source: 'manual_add', needsProfile: false, dnc: false, score: 66 },
  { person: 23, business: 'lavish', icp: 'export', status: 'replied', nextAction: 'review', nextActionInDays: -1, owner: 'bisma', source: 'paste_list', needsProfile: false, dnc: false, score: 84 },
  { person: 24, business: 'lavish', icp: 'export', status: 'connection_sent', nextAction: 'review', nextActionInDays: 3, owner: 'bisma', source: 'google_search', needsProfile: false, dnc: false, score: 49 },
  { person: 25, business: 'lavish', icp: 'export', status: 'needs_profile', nextAction: 'capture_profile', nextActionInDays: 0, owner: 'bisma', source: 'apollo_basic', needsProfile: true, dnc: false, score: null },
  { person: 26, business: 'lavish', icp: 'export', status: 'connection_accepted', nextAction: 'message_1', nextActionInDays: 0, owner: 'bisma', source: 'external_ingest', needsProfile: false, dnc: false, score: 74 },
  { person: 27, business: 'lavish', icp: 'export', status: 'dormant', nextAction: 'reactivation', nextActionInDays: 30, owner: 'bisma', source: 'file_csv', needsProfile: false, dnc: false, score: 39 },
  { person: 28, business: 'ai', icp: 'gcc', status: 'ready', nextAction: 'connection', nextActionInDays: 0, owner: 'admin', source: 'manual_add', needsProfile: false, dnc: false, score: 79 },
  { person: 29, business: 'ai', icp: 'gcc', status: 'followup_due', nextAction: 'followup_1', nextActionInDays: -1, owner: 'admin', source: 'mcp_agent', needsProfile: false, dnc: false, score: 68 },
  { person: 30, business: 'ai', icp: 'gcc', status: 'replied', nextAction: 'review', nextActionInDays: 0, owner: 'admin', source: 'research_agent', needsProfile: false, dnc: false, score: 86 },
  { person: 31, business: 'ai', icp: 'gcc', status: 'cooldown', nextAction: 'reactivation', nextActionInDays: 14, owner: 'admin', source: 'paste_list', needsProfile: false, dnc: false, score: 44 },
  { person: 32, business: 'ai', icp: 'gcc', status: 'wrong_person', nextAction: 'none', nextActionInDays: null, owner: 'admin', source: 'google_search', needsProfile: false, dnc: false, score: 20 },
  { person: 33, business: 'ai', icp: 'gcc', status: 'do_not_contact', nextAction: 'none', nextActionInDays: null, owner: 'admin', source: 'file_csv', needsProfile: false, dnc: true, score: 8 },
  { person: 34, business: 'zemnas', icp: 'media', status: 'new', nextAction: 'capture_profile', nextActionInDays: null, owner: 'osama', source: 'paste_list', needsProfile: false, dnc: false, score: 63 },
];

/** Exact inbound replies. The spec requires the verbatim text, not a summary. */
const REPLIES: readonly {
  readonly person: number;
  readonly outcome:
    | 'Interested'
    | 'Positive / needs info'
    | 'Maybe later'
    | 'No current need'
    | 'Not interested'
    | 'Wrong person'
    | 'Already has supplier'
    | 'Do not contact'
    | 'Other';
  readonly terminal: boolean;
  readonly text: string;
}[] = [
  { person: 10, outcome: 'Interested', terminal: false, text: "Thanks for reaching out — we're actually looking for extra editing capacity for Q3. Can you send rates and a sample?" },
  { person: 11, outcome: 'Positive / needs info', terminal: false, text: 'Interesting. What does onboarding look like, and how fast can you turn around a 12-minute episode?' },
  { person: 23, outcome: 'Maybe later', terminal: false, text: 'Not right now — we are mid-tender. Ping me again in a couple of months and I will have a clearer picture.' },
  { person: 30, outcome: 'Interested', terminal: false, text: 'Send a short deck. If the integration scope is realistic we can put a call in next week.' },
  { person: 31, outcome: 'No current need', terminal: false, text: 'We already have a partner for this, so no need at the moment. Thanks for thinking of us.' },
  { person: 32, outcome: 'Wrong person', terminal: true, text: 'I am not the right contact for this — procurement owns it. Try Rashid in IT.' },
  { person: 17, outcome: 'Do not contact', terminal: true, text: 'Please remove me from your list and do not contact me again.' },
  { person: 13, outcome: 'Already has supplier', terminal: false, text: 'We are locked into a supplier until the end of the year.' },
];

export async function seedOperational(
  db: PGlite,
  ids: OperationalSeedIds,
): Promise<{ readonly leads: number; readonly tasks: number; readonly replies: number }> {
  /**
   * Guards every parameterised statement in this module.
   *
   * A hand-written `insert ... values ($1..$n)` with a mismatched argument list fails at
   * execution time with a message that names neither the statement nor the call site, so
   * the count is checked here instead and the failure names the SQL.
   */
  const run = async (sql: string, params: readonly unknown[] = []): Promise<void> => {
    let highest = 0;
    for (const match of sql.matchAll(/\$(\d+)/g)) {
      const index = Number(match[1]);
      if (index > highest) highest = index;
    }
    if (highest !== params.length) {
      throw new Error(
        `seed statement expects ${String(highest)} parameters but was given ${String(params.length)}:\n${sql.trim().replace(/\s+/g, ' ')}`,
      );
    }
    await db.query(sql, params as unknown[]);
  };

  const businesses = { zemnas: ids.zemnas, lavish: ids.lavish, ai: ids.ai } as const;
  const icps = {
    media: ids.icpMedia,
    agency: ids.icpAgency,
    export: ids.icpExport,
    gcc: ids.icpGcc,
  } as const;
  const owners = {
    admin: ids.adminId,
    manager: ids.managerId,
    osama: ids.osamaId,
    bisma: ids.bismaId,
  } as const;

  /* ------------------------------------------------------------- companies -- */
  for (const [index, company] of COMPANIES.entries()) {
    const n = index + 1;
    await run(`insert into public.companies
         (id, name, normalized_name, primary_domain, normalized_domain, industry, employee_count, hq_country, linkedin_url, description, created_by)
       values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do nothing`,
      [
        OP_IDS.company(n),
        company.name,
        company.name.toLowerCase(),
        company.domain,
        company.industry,
        company.employees,
        company.country,
        `https://www.linkedin.com/company/${company.domain.split('.')[0] ?? 'company'}`,
        `${company.name} — ${company.industry} in ${company.country}.`,
        ids.adminId,
      ],
    );
  }

  /* ----------------------------------------------------------------- people -- */
  for (const [index, person] of PEOPLE.entries()) {
    const n = index + 1;
    const parts = person.name.split(' ');
    const first = parts[0] ?? person.name;
    const last = parts.slice(1).join(' ');
    const handle = person.name.toLowerCase().replace(/[^a-z]+/g, '-');
    const url = `https://www.linkedin.com/in/${handle}`;
    await run(`insert into public.people
         (id, full_name, normalized_name, first_name, last_name, headline, job_title, location,
          normalized_linkedin_url, linkedin_url, company_id, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [
        OP_IDS.person(n),
        person.name,
        person.name.toLowerCase(),
        first,
        last,
        `${person.title} at ${COMPANIES[person.company - 1]?.name ?? 'a company'}`,
        person.title,
        person.location,
        url.toLowerCase(),
        url,
        OP_IDS.company(person.company),
        ids.adminId,
      ],
    );
    await run(`insert into public.social_profiles (person_id, platform, profile_url, normalized_url, handle, source)
       values ($1,'linkedin',$2,$3,$4,'demo_seed')
       on conflict (platform, normalized_url) do nothing`,
      [OP_IDS.person(n), url, url.toLowerCase(), handle],
    );
  }

  /* ------------------------------------------------------------------ leads -- */
  let replyCount = 0;
  let taskCount = 0;
  let noteCount = 0;
  let interactionCount = 0;
  let conversationCount = 0;

  for (const [index, lead] of LEADS.entries()) {
    const n = index + 1;
    const leadId = OP_IDS.lead(n);
    const businessId = businesses[lead.business];
    const dueAt =
      lead.nextActionInDays === null
        ? null
        : new Date(Date.now() + lead.nextActionInDays * 86_400_000).toISOString();

    await run(`insert into public.leads
         (id, business_id, person_id, company_id, primary_icp_id, owner_user_id, outreach_identity_id,
          status, source_type, source_url, next_action_type, next_action_at, needs_profile, is_dnc, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (id) do nothing`,
      [
        leadId,
        businessId,
        OP_IDS.person(lead.person),
        OP_IDS.company(PEOPLE[lead.person - 1]?.company ?? 1),
        icps[lead.icp],
        owners[lead.owner],
        lead.business === 'zemnas'
          ? lead.owner === 'osama'
            ? ids.identityOsama
            : ids.identityBisma
          : lead.business === 'lavish'
            ? ids.identityBisma
            : ids.identityJames,
        lead.status,
        lead.source,
        `https://www.linkedin.com/in/${(PEOPLE[lead.person - 1]?.name ?? 'person').toLowerCase().replace(/[^a-z]+/g, '-')}`,
        lead.nextAction,
        dueAt,
        lead.needsProfile,
        lead.dnc,
        ids.adminId,
      ],
    );

    // The Primary ICP is expressed through the match table as well, so the ICP screens
    // show real primary/secondary counts rather than zeroes.
    await run(`insert into public.lead_icp_matches (lead_id, icp_id, is_primary, match_score, reason, created_by)
       values ($1,$2,true,$3,'Seeded primary match',$4)
       on conflict (lead_id, icp_id) do nothing`,
      [leadId, icps[lead.icp], lead.score, ids.adminId],
    );
    if (lead.status !== 'needs_profile' && lead.status !== 'new' && lead.icp !== 'agency') {
      await run(`insert into public.lead_icp_matches (lead_id, icp_id, is_primary, match_score, reason, created_by)
         values ($1,$2,false,$3,'Secondary match from shared buyer titles',$4)
         on conflict (lead_id, icp_id) do nothing`,
        [leadId, icps.agency, lead.score === null ? null : Math.max(10, lead.score - 15), ids.adminId],
      );
    }

    if (lead.dnc) {
      await run(`insert into public.contact_suppressions (person_id, channel, reason, active, business_id, created_by, evidence)
         values ($1,'linkedin','Explicit do-not-contact request',true,$2,$3,'Verbatim reply captured on the lead timeline')
         on conflict do nothing`,
        [OP_IDS.person(lead.person), businessId, ids.adminId],
      );
    }
    if (lead.status === 'cooldown') {
      await run(`insert into public.cooldowns (business_id, lead_id, person_id, reason, ends_at, is_active, created_by)
         values ($1,$2,$3,'Asked to be contacted later', now() + interval '21 days', true, $4)`,
        [businessId, leadId, OP_IDS.person(lead.person), ids.adminId],
      );
    }

    // Signals + evidence make the lead detail's "why this lead" panel real.
    if (lead.score !== null) {
      await run(`insert into public.signals (id, business_id, company_id, person_id, lead_id, kind, polarity, strength, label, detail, observed_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() - interval '4 days', $11)
         on conflict (id) do nothing`,
        [
          OP_IDS.signal(n),
          businessId,
          OP_IDS.company(PEOPLE[lead.person - 1]?.company ?? 1),
          OP_IDS.person(lead.person),
          leadId,
          lead.icp === 'media' ? 'hiring' : lead.icp === 'agency' ? 'contractor_need' : 'geography_size',
          'positive',
          lead.score,
          lead.icp === 'media' ? 'Actively hiring editor' : 'Contractor / freelancer need',
          'Observed on the company careers page during sourcing.',
          ids.adminId,
        ],
      );
      await run(`insert into public.source_evidence
           (id, business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json, content_hash, observed_at, confidence, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - interval '4 days', $10, $11)
         on conflict (business_id, content_hash) do nothing`,
        [
          OP_IDS.evidence(n),
          businessId,
          OP_IDS.person(lead.person),
          OP_IDS.company(PEOPLE[lead.person - 1]?.company ?? 1),
          leadId,
          lead.source,
          `https://www.linkedin.com/in/${(PEOPLE[lead.person - 1]?.name ?? 'person').toLowerCase().replace(/[^a-z]+/g, '-')}`,
          JSON.stringify({ captured: 'demo seed', source: lead.source }),
          `demo-seed-${String(n)}`,
          0.82,
          ids.adminId,
        ],
      );
    }

    /* --------------------------------------------------- notes and tasks --- */
    if (n % 3 === 0) {
      noteCount++;
      await run(`insert into public.notes (id, business_id, lead_id, person_id, author_user_id, body, is_internal)
         values ($1,$2,$3,$4,$5,$6,true)
         on conflict (id) do nothing`,
        [
          OP_IDS.note(noteCount),
          businessId,
          leadId,
          OP_IDS.person(lead.person),
          owners[lead.owner],
          'Checked the public site before sending: they list a production team of about six, so overflow capacity is plausible.',
        ],
      );
    }

    // My Day draws its sections from open tasks and lead next-actions, so every sender
    // needs a spread of due, overdue and completed work.
    if (n % 4 === 1) {
      taskCount++;
      await run(`insert into public.tasks (id, lead_id, business_id, owner_user_id, type, title, due_at, priority, status, note, source, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user',$4)
         on conflict (id) do nothing`,
        [
          OP_IDS.task(taskCount),
          leadId,
          businessId,
          owners[lead.owner],
          'follow_up',
          `Follow up with ${PEOPLE[lead.person - 1]?.name ?? 'the contact'}`,
          new Date(Date.now() - (n % 3) * 86_400_000).toISOString(),
          n % 5 === 0 ? 'urgent' : 'normal',
          'open',
          'Do not mention pricing until they ask.',
        ],
      );
    }
    if (n % 5 === 0) {
      taskCount++;
      await run(`insert into public.tasks (id, lead_id, business_id, owner_user_id, type, title, due_at, priority, status, completed_at, source, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user',$4)
         on conflict (id) do nothing`,
        [
          OP_IDS.task(taskCount),
          leadId,
          businessId,
          owners[lead.owner],
          'research',
          `Review ${COMPANIES[PEOPLE[lead.person - 1]?.company ?? 1]?.name ?? 'company'} output`,
          new Date(Date.now() - (n + 1) * 86_400_000).toISOString(),
          'low',
          'done',
          new Date(Date.now() - (n + 1) * 86_400_000 + 3_600_000).toISOString(),
        ],
      );
    }
    if (n % 7 === 0) {
      taskCount++;
      await run(`insert into public.tasks (id, lead_id, business_id, owner_user_id, type, title, due_at, priority, status, source, created_by)
         values ($1,$2,$3,$4,'admin',$5,$6,'normal','open','admin',$7)
         on conflict (id) do nothing`,
        [
          OP_IDS.task(taskCount),
          leadId,
          businessId,
          owners[lead.owner],
          'Confirm which business owns this follow-up',
          new Date(Date.now() + 86_400_000).toISOString(),
          ids.adminId,
        ],
      );
    }

    /* ------------------------------------------------------- interactions -- */
    interactionCount++;
    await run(`insert into public.interactions (id, business_id, lead_id, person_id, type, actor_user_id, outreach_identity_id, direction, summary, payload, source_client, occurred_at)
       values ($1,$2,$3,$4,'import',$5,null,'internal',$6,$7,'web', now() - interval '6 days')
       on conflict (id) do nothing`,
      [
        OP_IDS.interaction(interactionCount),
        businessId,
        leadId,
        OP_IDS.person(lead.person),
        ids.adminId,
        `Lead sourced from ${lead.source}`,
        JSON.stringify({ source: lead.source }),
      ],
    );

    // A Do-Not-Contact lead is deliberately left with no outbound history: the
    // `block_dnc_message` trigger refuses a message instance for a suppressed person, so
    // seeding one would contradict the state the lead is in. This is the database
    // enforcing the DNC rule against the seed, which is the intended behaviour.
    const hasBeenContacted =
      !lead.dnc && !['new', 'needs_profile', 'ready', 'connection_due'].includes(lead.status);
    if (hasBeenContacted) {
      conversationCount++;
      const conversationId = OP_IDS.conversation(conversationCount);
      const reply = REPLIES.find((candidate) => candidate.person === lead.person);
      await run(`insert into public.conversations (id, business_id, lead_id, channel, sender_identity_id, default_owner_user_id, last_outbound_at, last_inbound_at)
         values ($1,$2,$3,'linkedin',$4,$5, now() - interval '3 days', $6)
         on conflict (id) do nothing`,
        [
          conversationId,
          businessId,
          leadId,
          lead.business === 'zemnas' ? ids.identityOsama : lead.business === 'lavish' ? ids.identityBisma : ids.identityJames,
          owners[lead.owner],
          reply === undefined ? null : new Date(Date.now() - 86_400_000).toISOString(),
        ],
      );

      const enrollmentId = OP_IDS.enrollment(conversationCount);
      const state =
        reply !== undefined
          ? 'paused'
          : lead.status === 'dormant'
            ? 'dormant'
            : lead.status === 'cooldown'
              ? 'paused'
              : 'active';
      await run(`insert into public.sequence_enrollments
           (id, business_id, lead_id, sequence_id, sequence_version_id, state, current_step_order, started_at, paused_at, pause_reason, dormant_at, reactivation_due_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7, now() - interval '9 days', $8, $9, $10, $11, $12)
         on conflict (id) do nothing`,
        [
          enrollmentId,
          businessId,
          leadId,
          ids.seqZemnas,
          ids.seqVerZemnas,
          state,
          Math.min(3, conversationCount % 4),
          state === 'paused' ? new Date(Date.now() - 86_400_000).toISOString() : null,
          reply !== undefined ? 'Inbound reply paused the sequence' : state === 'paused' ? 'Paused by the sender' : null,
          state === 'dormant' ? new Date(Date.now() - 5 * 86_400_000).toISOString() : null,
          state === 'dormant' ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null,
          owners[lead.owner],
        ],
      );

      // A SENT instance with its immutable version: the lead timeline's outbound entry.
      const messageId = OP_IDS.message(conversationCount);
      await run(`insert into public.message_instances
           (id, conversation_id, state, due_at, sent_at, business_id, lead_id, step_order, step_kind)
         values ($1,$2,'SENT', now() - interval '3 days', now() - interval '3 days', $3,$4,1,'message')
         on conflict (id) do nothing`,
        [messageId, conversationId, businessId, leadId],
      );
      await run(`insert into public.message_versions (id, message_instance_id, content, generated_by_model, version_no, created_by, created_at)
         values ($1,$2,$3,'deepseek-flash',1,$4, now() - interval '3 days')
         on conflict (message_instance_id, version_no) do nothing`,
        [
          OP_IDS.messageVersion(conversationCount),
          messageId,
          `${PEOPLE[lead.person - 1]?.name.split(' ')[0] ?? 'there'} — saw ${COMPANIES[PEOPLE[lead.person - 1]?.company ?? 1]?.name ?? 'your team'} is scaling output. We run overflow editing under your brand, so your team keeps the client relationship. Worth a short call?`,
          owners[lead.owner],
        ],
      );

      // The inbound reply itself: verbatim text, captured as an interaction and an outcome.
      if (reply !== undefined) {
        replyCount++;
        interactionCount++;
        await run(`insert into public.interactions (id, business_id, lead_id, person_id, conversation_id, type, actor_user_id, direction, summary, payload, source_client, occurred_at)
           values ($1,$2,$3,$4,$5,'inbound_reply',null,'inbound',$6,$7,'companion', now() - interval '1 day')
           on conflict (id) do nothing`,
          [
            OP_IDS.interaction(interactionCount),
            businessId,
            leadId,
            OP_IDS.person(lead.person),
            conversationId,
            reply.text.slice(0, 120),
            JSON.stringify({ body: reply.text, verbatim: true }),
          ],
        );
        await run(`insert into public.conversation_outcomes (id, conversation_id, lead_id, business_id, outcome, is_terminal, reason, actor_user_id, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 day')
           on conflict (id) do nothing`,
          [
            OP_IDS.outcome(replyCount),
            conversationId,
            leadId,
            businessId,
            reply.outcome,
            reply.terminal,
            'Recorded from the pasted reply.',
            owners[lead.owner],
          ],
        );
        await run(`insert into public.notes (id, business_id, lead_id, person_id, author_user_id, body, is_internal, created_at)
           values ($1,$2,$3,$4,$5,$6,true, now() - interval '1 day')
           on conflict (id) do nothing`,
          [
            OP_IDS.note(100 + replyCount),
            businessId,
            leadId,
            OP_IDS.person(lead.person),
            owners[lead.owner],
            `Exact reply pasted from LinkedIn:\n\n"${reply.text}"`,
          ],
        );
      }
    }
  }

  /* ------------------------------------------------------------ imports ---- */
  const importBatches: readonly {
    readonly n: number;
    readonly business: 'zemnas' | 'lavish' | 'ai';
    readonly source: 'file_csv' | 'file_xlsx' | 'paste_list' | 'google_search' | 'apollo_basic';
    readonly icp: 'media' | 'agency' | 'export' | 'gcc' | null;
    readonly status: 'completed' | 'failed' | 'pending';
    readonly rows: number;
    readonly created: number;
    readonly updated: number;
    readonly duplicates: number;
    readonly needsProfile: number;
    readonly failed: number;
    readonly skipped: number;
  }[] = [
    { n: 1, business: 'zemnas', source: 'file_csv', icp: 'media', status: 'completed', rows: 24, created: 19, updated: 3, duplicates: 2, needsProfile: 4, failed: 0, skipped: 0 },
    { n: 2, business: 'zemnas', source: 'google_search', icp: null, status: 'completed', rows: 12, created: 9, updated: 0, duplicates: 1, needsProfile: 2, failed: 0, skipped: 0 },
    { n: 3, business: 'zemnas', source: 'apollo_basic', icp: 'agency', status: 'failed', rows: 8, created: 0, updated: 0, duplicates: 0, needsProfile: 0, failed: 8, skipped: 0 },
    { n: 4, business: 'lavish', source: 'file_xlsx', icp: 'export', status: 'completed', rows: 15, created: 11, updated: 2, duplicates: 1, needsProfile: 1, failed: 0, skipped: 0 },
    { n: 5, business: 'ai', source: 'paste_list', icp: 'gcc', status: 'pending', rows: 6, created: 0, updated: 0, duplicates: 0, needsProfile: 0, failed: 0, skipped: 0 },
  ];

  for (const batch of importBatches) {
    await run(`insert into public.import_batches
         (id, source, business, requested_primary_icp, business_id, requested_icp_id, auto_match, row_count, status,
          created_count, updated_count, duplicate_count, needs_profile_count, failed_count, skipped_count, created_by, raw_summary)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (id) do nothing`,
      [
        OP_IDS.batch(batch.n),
        batch.source,
        batch.business,
        batch.icp,
        businesses[batch.business],
        batch.icp === null ? null : icps[batch.icp],
        batch.icp === null,
        batch.rows,
        batch.status,
        batch.created,
        batch.updated,
        batch.duplicates,
        batch.needsProfile,
        batch.failed,
        batch.skipped,
        ids.adminId,
        JSON.stringify({ headers: ['name', 'company', 'job title', 'linkedin url'], mapping: { name: 0, company: 1, jobTitle: 2, linkedinUrl: 3 } }),
      ],
    );

    // Per-row outcomes, so the import detail table renders every result value.
    const results = ['created', 'updated', 'duplicate', 'needs_profile', 'failed', 'skipped'] as const;
    for (let row = 1; row <= Math.min(batch.rows, 8); row++) {
      const personIndex = ((batch.n * 8 + row) % PEOPLE.length) + 1;
      const person = PEOPLE[personIndex - 1];
      const linkIndex = (batch.n + row) % results.length;
      await run(`insert into public.import_rows (batch_id, row_number, raw, normalized, result, person_id, company_id, message)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (batch_id, row_number) do nothing`,
        [
          OP_IDS.batch(batch.n),
          row,
          JSON.stringify({
            name: person?.name ?? '',
            company: COMPANIES[(person?.company ?? 1) - 1]?.name ?? '',
            'job title': person?.title ?? '',
            'linkedin url': `https://www.linkedin.com/in/${(person?.name ?? 'person').toLowerCase().replace(/[^a-z]+/g, '-')}`,
          }),
          JSON.stringify({ fullName: person?.name ?? '', jobTitle: person?.title ?? '' }),
          batch.status === 'pending' ? 'pending' : (results[linkIndex] ?? 'created'),
          batch.status === 'pending' ? null : OP_IDS.person(personIndex),
          OP_IDS.company(person?.company ?? 1),
          batch.status === 'failed'
            ? 'The enrichment provider rejected this row.'
            : 'Row accepted.',
        ],
      );
    }
  }

  /* ------------------------------------------------- duplicates and queue -- */
  /**
   * The two sides are named by their LEAD index, not just their person index.
   *
   * `duplicate_candidates` stores only the existing side's lead, so the incoming side's lead
   * has to be findable from the incoming person. Naming both sides explicitly keeps the two
   * from resolving to the same row — which is not merely untidy: when the read returns the
   * same lead object for both props, React's flight serialiser refuses to send the same
   * reference twice and the page fails to render.
   */
  const duplicatePairs: readonly {
    readonly n: number;
    readonly business: 'zemnas' | 'lavish' | 'ai';
    readonly incomingLead: number;
    readonly existingLead: number;
    readonly reason: string;
    readonly confidence: number;
  }[] = [
    { n: 1, business: 'zemnas', incomingLead: 1, existingLead: 2, reason: 'linkedin_url', confidence: 0.98 },
    { n: 2, business: 'zemnas', incomingLead: 3, existingLead: 4, reason: 'name_company_title', confidence: 0.71 },
    { n: 3, business: 'lavish', incomingLead: 21, existingLead: 27, reason: 'company_domain', confidence: 0.64 },
  ];
  for (const pair of duplicatePairs) {
    const incomingSpec = LEADS[pair.incomingLead - 1];
    const existingSpec = LEADS[pair.existingLead - 1];
    if (incomingSpec === undefined || existingSpec === undefined) {
      throw new Error(`duplicate pair ${String(pair.n)} names a lead that does not exist`);
    }
    if (incomingSpec.person === existingSpec.person) {
      throw new Error(`duplicate pair ${String(pair.n)} matches a person against themselves`);
    }
    await run(`insert into public.duplicate_candidates
         (id, business_id, incoming_person_id, existing_person_id, existing_lead_id, match_reason, confidence, status, payload)
       values ($1,$2,$3,$4,$5,$6,$7,'open',$8)
       on conflict (id) do nothing`,
      [
        OP_IDS.duplicate(pair.n),
        businesses[pair.business],
        OP_IDS.person(incomingSpec.person),
        OP_IDS.person(existingSpec.person),
        OP_IDS.lead(pair.existingLead),
        pair.reason,
        pair.confidence,
        JSON.stringify({
          incomingName: PEOPLE[incomingSpec.person - 1]?.name,
          existingName: PEOPLE[existingSpec.person - 1]?.name,
        }),
      ],
    );
  }

  const queueItems = LEADS.filter((lead) => lead.needsProfile);
  for (const [index, lead] of queueItems.entries()) {
    const leadIndex = LEADS.indexOf(lead) + 1;
    await run(`insert into public.profile_capture_queue (id, business_id, lead_id, person_id, state, reason, assigned_user_id)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do nothing`,
      [
        OP_IDS.queue(index + 1),
        businesses[lead.business],
        OP_IDS.lead(leadIndex),
        OP_IDS.person(lead.person),
        index === 1 ? 'in_progress' : 'pending',
        'The import carried only a partial profile: no headline, location or company page.',
        owners[lead.owner],
      ],
    );
  }

  /* ------------------------------------------------------------ automations -- */
  const automations: readonly {
    readonly n: number;
    readonly name: string;
    readonly runner: 'browseros' | 'opencode' | 'n8n' | 'other';
    readonly purpose: string;
    readonly runMode: 'manual' | 'scheduled' | 'continuous';
    readonly schedule: string | null;
    readonly sourceType: string;
    readonly business: 'zemnas' | 'lavish' | 'ai';
    readonly active: boolean;
  }[] = [
    { n: 1, name: 'BrowserOS LinkedIn capture', runner: 'browseros', purpose: 'Open queued profiles and paste them back for extraction.', runMode: 'manual', schedule: null, sourceType: 'manual_companion', business: 'zemnas', active: true },
    { n: 2, name: 'Nightly Google search ingest', runner: 'n8n', purpose: 'Run the saved searches and post results to the ingest endpoint.', runMode: 'scheduled', schedule: '0 2 * * *', sourceType: 'google_search', business: 'zemnas', active: true },
    { n: 3, name: 'Apollo basic enrichment', runner: 'opencode', purpose: 'Top up missing titles for rows that passed validation.', runMode: 'scheduled', schedule: '0 */6 * * *', sourceType: 'apollo_basic', business: 'lavish', active: false },
  ];
  for (const automation of automations) {
    await run(`insert into public.automation_configs (id, business_id, name, runner, purpose, run_mode, schedule, source_type, icp_id, is_active, last_run_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() - interval '5 hours', $11)
       on conflict (id) do nothing`,
      [
        OP_IDS.automation(automation.n),
        businesses[automation.business],
        automation.name,
        automation.runner,
        automation.purpose,
        automation.runMode,
        automation.schedule,
        automation.sourceType,
        automation.sourceType === 'google_search' ? ids.icpMedia : null,
        automation.active,
        ids.adminId,
      ],
    );
    await run(`insert into public.agent_runs (id, business_id, automation_config_id, actor_user_id, agent_name, objective, state, started_at, finished_at, summary, result, stats)
       values ($1,$2,$3,$4,$5,$6,$7, now() - interval '5 hours', now() - interval '5 hours' + interval '4 minutes', $8, $9, $10)
       on conflict (id) do nothing`,
      [
        OP_IDS.agentRun(automation.n),
        businesses[automation.business],
        OP_IDS.automation(automation.n),
        ids.adminId,
        automation.name,
        automation.purpose,
        automation.active ? 'succeeded' : 'failed',
        automation.active ? 'Imported 14 rows, 3 needed a profile capture.' : 'The provider returned 429 and the run stopped.',
        JSON.stringify({ rowsIn: 14, created: 11, needsProfile: 3 }),
        JSON.stringify({ durationMs: 240_000 }),
      ],
    );
  }

  /* ----------------------------------------------------------- saved views -- */
  await run(`insert into public.saved_views (id, business_id, owner_user_id, scope, name, filters, sort, is_shared)
     values
       ($1,$4,$5,'leads','Hot media leads in the US',$6,$7,false),
       ($2,$4,$5,'leads','Needs profile capture',$8,$7,true),
       ($3,$4,$5,'companion_leads','Replied, awaiting my answer',$9,$7,false)
     on conflict (id) do nothing`,
    [
      OP_IDS.savedView(1),
      OP_IDS.savedView(2),
      OP_IDS.savedView(3),
      ids.zemnas,
      ids.osamaId,
      JSON.stringify({ status: 'ready', icpId: ids.icpMedia }),
      JSON.stringify({ sort: 'score' }),
      JSON.stringify({ needsProfile: 'true' }),
      JSON.stringify({ status: 'replied' }),
    ],
  );

  return { leads: LEADS.length, tasks: taskCount, replies: replyCount };
}
