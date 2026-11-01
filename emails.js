const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.in', 'proton.me', 'protonmail.com', 'icloud.com', 'rediffmail.com']);
const HIRING = /^(careers?|jobs?|hiring|hr|people|talent|recruit(ment|ing|er)?|work|join|joinus|internships?|apply)$/i;
const FOUNDERS = /^(founders?|ceo|cofounders?)$/i;
const GENERAL = /^(hello|hi|hey|contact|contactus|info|support|help|admin|office|mail|team|enquiries|enquiry|sales|business|partnerships?|press|media|connect)$/i;
const JUNK_LOCAL = /^(name|you|your|user|username|email|example|test|john\.?doe|jane\.?doe|noreply|no-reply|donotreply|privacy|legal|abuse|postmaster|webmaster|dpo|unsubscribe)$/i;
const JUNK_DOMAIN = /(sentry|wixpress|example\.|domain\.com|yourcompany|email\.com|yoursite|mysite|schema\.org|w3\.org)/i;

export function decodeCfEmail(hex) {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
}

const deobfuscate = (s) => s
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.');

/** Emails written on the page, including mailto links and Cloudflare-protected ones. */
export function extractEmails($) {
    const found = new Set();
    $('a[href^="mailto:"]').each((_, a) => found.add(decodeURIComponent($(a).attr('href').slice(7).split('?')[0]).trim().toLowerCase()));
    $('[data-cfemail]').each((_, el) => { try { found.add(decodeCfEmail($(el).attr('data-cfemail')).toLowerCase()); } catch { /* ignore */ } });
    // Tags become spaces so "Mail<span>hi@x.in</span>" cannot glue words onto an address.
    const plain = String($.html() ?? '')
        .replace(/<style[\s\S]*?<\/style>|<script(?![^>]*ld\+json)[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&#64;|&commat;/g, '@').replace(/&#46;/g, '.').replace(/&amp;/g, '&');
    const text = deobfuscate(plain);
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) found.add(m[0].toLowerCase());
    return [...found].filter((e) => {
        const [local, domain] = e.split('@');
        return local && domain && e.length <= 80 && !JUNK_LOCAL.test(local) && !JUNK_DOMAIN.test(domain)
            && !/\.(png|jpe?g|gif|svg|webp|js|css|woff2?)$/i.test(domain);
    });
}

export function emailKind(email) {
    const local = email.split('@')[0].replace(/[._-]/g, '');
    if (HIRING.test(local)) return 'hiring';
    if (FOUNDERS.test(local)) return 'founders';
    if (GENERAL.test(local)) return 'general';
    return 'personal';
}

/** Does this address look like it belongs to this person (priya@, priya.nair@, pnair@ ...)? */
export function matchesPerson(email, name) {
    const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    const parts = name.toLowerCase().replace(/^(dr|mr|ms|mrs|prof)\.?\s+/, '').split(/\s+/).map((p) => p.replace(/[^a-z]/g, '')).filter(Boolean);
    if (parts.length < 2) return false;
    const first = parts[0]; const last = parts[parts.length - 1];
    const options = [first, last, first + last, last + first, first[0] + last, first + last[0]];
    return options.some((o) => o.length >= 3 && local === o);
}

/** Keeps addresses on the company's own domain, or on free mail if the company lists one. */
export function relevantEmails(emails, companyDomain, { gmailOnly = false } = {}) {
    return emails.filter((e) => {
        const d = e.split('@')[1];
        if (gmailOnly) return d === 'gmail.com' || d === 'googlemail.com';
        return d === companyDomain || d.endsWith(`.${companyDomain}`) || FREE_MAIL.has(d);
    });
}

export function findLinks($, base) {
    const out = { careersUrl: '', contactFormUrl: '', companyLinkedin: '', personLinkedin: [] };
    $('a[href]').each((_, a) => {
        const href = $(a).attr('href') ?? '';
        let url; try { url = new URL(href, base).toString(); } catch { return; }
        const label = `${$(a).text()} ${url}`;
        if (!out.careersUrl && /careers?|jobs|join[-\s]?us|work[-\s]with[-\s]us|we(?:'|’)re[-\s]hiring/i.test(label) && new URL(url).origin === new URL(base).origin) out.careersUrl = url;
        if (!out.contactFormUrl && /contact|get[-\s]in[-\s]touch|reach[-\s]us/i.test(label) && new URL(url).origin === new URL(base).origin) out.contactFormUrl = url;
        if (/linkedin\.com\/company\//i.test(url) && !out.companyLinkedin) out.companyLinkedin = url.split('?')[0];
        if (/linkedin\.com\/in\//i.test(url)) out.personLinkedin.push(url.split('?')[0]);
    });
    return out;
}

/** Best address of each kind from everything found on the site. */
export function rankEmails(emails) {
    const pick = (kind) => emails.find((e) => emailKind(e) === kind) ?? '';
    return { hiringEmail: pick('hiring'), foundersEmail: pick('founders'), generalEmail: pick('general') };
}

const ascii = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
function nameParts(name) {
    const parts = name.replace(/^(dr|mr|ms|mrs|prof)\.?\s+/i, '').split(/\s+/).map(ascii).filter(Boolean);
    return parts.length >= 2 ? { first: parts[0], last: parts[parts.length - 1] } : null;
}
const PATTERNS = {
    'first': (f, l) => f, 'last': (f, l) => l, 'first.last': (f, l) => `${f}.${l}`, 'firstlast': (f, l) => `${f}${l}`,
    'f.last': (f, l) => `${f[0]}.${l}`, 'flast': (f, l) => `${f[0]}${l}`, 'first.l': (f, l) => `${f}.${l[0]}`, 'firstl': (f, l) => `${f}${l[0]}`,
};

/** Which naming pattern does this published address follow for this person? (first.last, flast ...) */
export function patternFor(name, email) {
    const n = nameParts(name);
    if (!n) return null;
    const local = email.split('@')[0].toLowerCase();
    return Object.keys(PATTERNS).find((k) => PATTERNS[k](n.first, n.last) === local && local.length >= 3) ?? null;
}

/** Candidate address for a person: from a pattern seen on the site, else the two most common ones. */
export function guessAddresses(name, domain, pattern = null) {
    const n = nameParts(name);
    if (!n) return [];
    const keys = pattern ? [pattern] : ['first', 'first.last'];
    return keys.map((k) => `${PATTERNS[k](n.first, n.last)}@${domain}`);
}
