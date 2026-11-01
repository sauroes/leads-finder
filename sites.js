import { Actor, log } from 'apify';

// Directories, news, job boards and social sites. They talk about startups but are not the startup's own site.
const NON_COMPANY_NAMES = [
    'linkedin', 'crunchbase', 'tracxn', 'inc42', 'entrackr', 'yourstory', 'techcrunch', 'economictimes',
    'livemint', 'medium', 'substack', 'clutch', 'goodfirms', 'g2', 'capterra', 'producthunt', 'wikipedia',
    'github', 'facebook', 'instagram', 'twitter', 'youtube', 'reddit', 'quora', 'glassdoor', 'indeed',
    'naukri', 'internshala', 'ambitionbox', 'zaubacorp', 'startupindia', 'f6s', 'wellfound', 'angel',
    'pinterest', 'forbes', 'businessinsider', 'thehindu', 'hindustantimes', 'ndtv', 'wordpress', 'blogspot',
    'wixsite', 'notion', 'google', 'apple', 'amazon', 'microsoft', 'ycombinator', 'sortlist', 'topstartups',
    'startupranking', 'dealroom', 'pitchbook', 'owler', 'zoominfo', 'apollo', 'rocketreach', 'sulekha',
    'justdial', 'indiamart', 'quora', 'tumblr', 'bloomberg', 'reuters', 'moneycontrol', 'financialexpress',
];
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

export const hostOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};

/** "careers.acme.co.in" -> "acme.co.in" */
export function registrableDomain(host) {
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const n = SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
    return labels.slice(-n).join('.');
}

export function isCompanySite(url, excludeDomains = []) {
    const host = hostOf(url);
    if (!host || !host.includes('.')) return false;
    const domain = registrableDomain(host);
    if (excludeDomains.some((d) => domain === d || host.endsWith(`.${d}`))) return false;
    if (/\.(gov|edu)(\.[a-z]{2})?$|\.ac\.[a-z]{2}$/.test(host)) return false;
    return !host.split('.').some((l) => NON_COMPANY_NAMES.includes(l)) && !/^x\.com$/.test(host);
}

export function buildQueries({ keywords, locations }) {
    const exclude = ['linkedin.com', 'crunchbase.com', 'tracxn.com', 'inc42.com', 'yourstory.com', 'medium.com']
        .map((d) => `-site:${d}`).join(' ');
    const out = [];
    for (const kw of keywords) {
        for (const loc of locations) {
            out.push(`${kw} startup ${loc} "our team" founders ${exclude}`);
            out.push(`${kw} startup ${loc} "about us" "founded in" ("seed" OR "pre-seed" OR "backed by") ${exclude}`);
        }
    }
    return out;
}

/** Google search -> one entry per company website (homepage address). */
export async function discoverCompanySites({ keywords, locations, pages = 2, excludeDomains = [], limit = 200 }) {
    const queries = buildQueries({ keywords, locations });
    const run = await Actor.call('apify/google-search-scraper', {
        queries: queries.join('\n'), resultsPerPage: 10, maxPagesPerQuery: pages, countryCode: 'in', languageCode: 'en',
    });
    const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems();
    const byDomain = new Map();
    let skipped = 0;
    for (const page of items) {
        for (const hit of page.organicResults ?? []) {
            const url = String(hit.url ?? '');
            if (!url.startsWith('http') || url.includes('google.')) { skipped++; continue; }
            if (!isCompanySite(url, excludeDomains)) { skipped++; continue; }
            const domain = registrableDomain(hostOf(url));
            if (!byDomain.has(domain)) byDomain.set(domain, `${new URL(url).origin}/`);
        }
    }
    log.info(`Search: ${byDomain.size} company site(s) found, ${skipped} result(s) skipped (news, directories, social, job boards).`);
    return [...byDomain.values()].slice(0, limit);
}

const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** From search results for "Name" "Company" LinkedIn, pick a profile that clearly is this person at this company. */
export function pickLinkedinResult(hits, { name, company, domain }) {
    const tokens = norm(name).replace(/^(dr|mr|ms|mrs|prof)\.?\s+/, '').split(/\s+/).filter((t) => t.length > 1);
    if (tokens.length < 2) return '';
    const first = tokens[0]; const last = tokens[tokens.length - 1];
    const brand = norm(company).replace(/[^a-z0-9 ]/g, '').trim();
    const label = norm(domain).split('.')[0];
    for (const hit of hits ?? []) {
        const m = String(hit.url ?? '').match(/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i);
        if (!m) continue;
        const text = norm(`${hit.title ?? ''} ${hit.description ?? ''}`);
        const nameOk = text.includes(first) && text.includes(last);
        const companyOk = (brand.length >= 3 && text.includes(brand)) || (label.length >= 4 && text.includes(label));
        if (nameOk && companyOk) return m[0];
    }
    return '';
}

/** One Google search per person (batched into a single run). Returns Map(key -> profile link). */
export async function findLinkedinProfiles(people, { pages = 1 } = {}) {
    const queries = people.map((p) => `"${p.name}" "${p.company}" site:linkedin.com/in`);
    if (!queries.length) return new Map();
    const run = await Actor.call('apify/google-search-scraper', {
        queries: queries.join('\n'), resultsPerPage: 5, maxPagesPerQuery: pages, countryCode: 'in', languageCode: 'en',
    });
    const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems();
    const hitsByQuery = new Map();
    for (const item of items) {
        const term = item.searchQuery?.term;
        if (term) hitsByQuery.set(term, [...(hitsByQuery.get(term) ?? []), ...(item.organicResults ?? [])]);
    }
    const found = new Map();
    people.forEach((p, i) => {
        const url = pickLinkedinResult(hitsByQuery.get(queries[i]), p);
        if (url) found.set(p.key, url);
    });
    log.info(`LinkedIn links: ${found.size} of ${people.length} contact(s) matched to a profile.`);
    return found;
}
