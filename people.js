const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Order matters: the first matching rule decides the kind.
const ROLE_RULES = [
    { kind: 'hiring', weight: 9, re: /\b(head of (people|talent|hr|human resources)|hr\s+(head|manager|lead|business partner|executive)|human resources|talent\s+(acquisition|partner|lead|manager)|people\s+(operations|partner|lead|ops|&\s*culture)|recruit(er|ing|ment)|chief people officer|vp\s+(of\s+)?(people|hr))\b/i },
    { kind: 'founder', weight: 10, re: /\b(co-?founder|founder)\b/i },
    { kind: 'ceo', weight: 10, re: /\b(ceo|chief executive|managing director|\bmd\b|president)\b/i },
    { kind: 'leader', weight: 5, re: /\b(coo|chief operating|cto|chief technology|cpo|chief product|head of (operations|product|engineering|growth|marketing|design))\b/i },
];
const FOUNDING_STAFF = /founding\s+(engineer|designer|member|team|marketer|product|sales|ae|developer|analyst)/i;
const NOT_NAME = /\b(team|about|our|join|us|careers?|contact|read|more|view|profile|linkedin|the|and|meet|leadership|founders?|story|company|mission|values|learn|apply|home|blog|press|news|ceo|cto|coo|head|manager|director|intern)\b/i;

export function classifyRole(title) {
    const t = clean(title);
    if (!t || t.length > 90) return null;
    if (FOUNDING_STAFF.test(t) && !/\b(co-?founder|founder)\b(?!\s*s?\s+(office|team))/i.test(t.replace(FOUNDING_STAFF, ''))) return null;
    for (const rule of ROLE_RULES) if (rule.re.test(t)) return { kind: rule.kind, weight: rule.weight };
    return null;
}

export function looksLikeName(s) {
    const t = clean(s).replace(/^(dr|mr|ms|mrs|prof)\.?\s+/i, '');
    if (t.length < 5 || t.length > 40 || NOT_NAME.test(t)) return false;
    const parts = t.split(' ');
    if (parts.length < 2 || parts.length > 4) return false;
    return parts.every((p) => /^[\p{Lu}][\p{L}.'’-]*$/u.test(p));
}

const SOCIAL = /(linkedin|twitter|facebook|instagram|github|youtube|medium|x)\.(com|co)$|^x\.com$|t\.me|wa\.me|calendly|mailto:/i;
export const externalLink = (hrefs) => hrefs.find((h) => /^https?:\/\//i.test(h) && !SOCIAL.test(new URL(h).hostname.replace(/^www\./, '')) && !/mailto:/i.test(h)) ?? '';

const own = ($, el) => clean($(el).clone().children().remove().end().text());
const BLOCK = 'h1,h2,h3,h4,h5,h6,p,div,li,ul,ol,section,article,table';

function flattenLd(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => flattenLd(n, out));
    else if (node && typeof node === 'object') { out.push(node); Object.values(node).forEach((v) => { if (typeof v === 'object') flattenLd(v, out); }); }
    return out;
}

function fromJsonLd($) {
    const found = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        let data; try { data = JSON.parse($(el).contents().text()); } catch { return; }
        for (const node of flattenLd(data)) {
            const types = [].concat(node['@type'] ?? []);
            const add = (p, fallbackTitle) => {
                if (!p || typeof p !== 'object') return;
                const name = clean(p.name);
                const title = clean(p.jobTitle ?? fallbackTitle);
                const same = [].concat(p.sameAs ?? []).find((u) => /linkedin\.com\/in\//i.test(u));
                if (looksLikeName(name)) found.push({ name, title, linkedinUrl: same ?? '', websiteUrl: typeof p.url === 'string' ? p.url : '', from: 'json-ld' });
            };
            if (types.includes('Person')) add(node);
            if (types.includes('Organization') || types.includes('Corporation') || types.includes('LocalBusiness')) {
                [].concat(node.founder ?? node.founders ?? []).forEach((p) => add(p, 'Founder'));
                [].concat(node.employee ?? []).forEach((p) => add(p));
            }
        }
    });
    return found;
}

function nameNear($, titleEl) {
    const el = $(titleEl);
    const sameText = clean(el.text());
    // "Asha Rao, Co-founder & CEO" in one element
    const split = sameText.match(/^(.{5,40}?)\s*[,|–—-]\s*(.{3,70})$/);
    if (split && looksLikeName(split[1]) && classifyRole(split[2])) return { name: clean(split[1]), title: clean(split[2]), scope: el.parent() };
    for (const sib of el.prevAll().slice(0, 3).toArray()) { const t = clean($(sib).text()); if (looksLikeName(t)) return { name: t, scope: el.parent() }; }
    for (const sib of el.nextAll().slice(0, 2).toArray()) { const t = clean($(sib).text()); if (looksLikeName(t)) return { name: t, scope: el.parent() }; }
    let scope = el.parent();
    for (let depth = 0; depth < 3 && scope.length; depth++, scope = scope.parent()) {
        if (clean(scope.text()).length > 400) break;
        for (const h of scope.find('h1,h2,h3,h4,h5,h6,strong,b,a').toArray()) {
            const t = clean($(h).text());
            if (looksLikeName(t)) return { name: t, scope };
        }
    }
    return null;
}

function fromCards($) {
    const found = [];
    $('h1,h2,h3,h4,h5,h6,p,span,div,li,strong,b,em,small,figcaption').each((_, el) => {
        if ($(el).children(BLOCK).length) return;
        const text = clean($(el).text());
        if (!text || text.length > 90) return;
        const titleOnly = text.replace(/^.{5,40}?\s*[,|–—-]\s*/, (m) => (looksLikeName(m.replace(/\s*[,|–—-]\s*$/, '')) ? '' : m));
        if (!classifyRole(titleOnly)) return;
        const hit = nameNear($, el);
        if (!hit) return;
        const title = hit.title ?? titleOnly;
        const linkedinUrl = hit.scope.find('a[href*="linkedin.com/in/"]').first().attr('href') ?? '';
        const websiteUrl = externalLink(hit.scope.find('a[href]').toArray().map((a) => $(a).attr('href') ?? ''));
        found.push({ name: hit.name, title, linkedinUrl, websiteUrl, from: 'page' });
    });
    return found;
}

/** Everyone on this page with a founder, CEO, hiring or leadership title. */
export function extractPeople($) {
    const merged = new Map();
    for (const p of [...fromJsonLd($), ...fromCards($)]) {
        const role = classifyRole(p.title);
        if (!role) continue;
        const key = p.name.toLowerCase();
        const prev = merged.get(key);
        if (!prev || role.weight > prev.weight) merged.set(key, { ...p, kind: role.kind, weight: role.weight });
        else {
            if (!prev.linkedinUrl && p.linkedinUrl) prev.linkedinUrl = p.linkedinUrl;
            if (!prev.websiteUrl && p.websiteUrl) prev.websiteUrl = p.websiteUrl;
        }
    }
    return [...merged.values()];
}

/** Fallback when the page has no usable structure: ask Claude to read the team text. */
export async function extractPeopleWithLlm(text, { apiKey, model }) {
    const prompt = `Page text:\n${text.slice(0, 9000)}\n\nList the people named on this page who are founders, CEO/managing directors, or in HR, people or talent roles. `
        + 'Return a JSON array only (no prose, no code fences) of {"name": "...", "title": "..."}. Use only names and titles written on the page. Return [] if there are none.';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Claude read failed (${res.status})`);
    const data = await res.json();
    const raw = (data.content ?? []).map((b) => b.text ?? '').join('').replace(/```json|```/g, '').trim();
    return JSON.parse(raw).filter((p) => looksLikeName(p.name) && classifyRole(p.title))
        .map((p) => ({ name: clean(p.name), title: clean(p.title), linkedinUrl: '', from: 'llm', ...classifyRole(p.title) }));
}

/**
 * Who to write to. In a startup the founder or CEO both hires and signs off, so they lead.
 * A dedicated people/HR/talent person becomes the backup (or the lead if preferHiringLead is on).
 */
export function pickContacts(people, { preferHiringLead = false } = {}) {
    const byWeight = (a, b) => b.weight - a.weight || a.name.localeCompare(b.name);
    const founders = people.filter((p) => p.kind === 'founder' || p.kind === 'ceo').sort((a, b) => (b.kind === 'founder' && /ceo|chief executive/i.test(b.title) ? 1 : 0) - (a.kind === 'founder' && /ceo|chief executive/i.test(a.title) ? 1 : 0) || byWeight(a, b));
    const hiring = people.filter((p) => p.kind === 'hiring').sort(byWeight);
    const leaders = people.filter((p) => p.kind === 'leader').sort(byWeight);
    let primary; let alternate; let reason;
    if (preferHiringLead && hiring.length) { primary = hiring[0]; alternate = founders[0]; reason = 'Runs hiring (people/HR/talent role)'; }
    else if (founders.length) { primary = founders[0]; alternate = hiring[0] ?? founders[1] ?? leaders[0]; reason = 'Founder/CEO: decides hiring at this stage'; }
    else if (hiring.length) { primary = hiring[0]; alternate = leaders[0]; reason = 'Runs hiring (people/HR/talent role)'; }
    else if (leaders.length) { primary = leaders[0]; alternate = leaders[1]; reason = 'Senior leader (no founder or HR listed)'; }
    return { primary, alternate, reason: primary ? reason : '' };
}
