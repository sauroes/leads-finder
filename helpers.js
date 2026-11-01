import { registrableDomain } from './sites.js';

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const SUBPAGE = /about|team|people|founders?|leadership|company|story|who-we-are|contact|careers?|jobs|join/i;
const SKIP_PATH = /\.(pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|gif|svg)(\?|$)|\/(blog|privacy|terms|policy|cookie|login|signup|cart|shop)(\/|$)/i;

export function companyName($, domain) {
    const site = clean($('meta[property="og:site_name"]').attr('content'));
    if (site && site.length <= 40) return site;
    const first = clean($('title').text()).split(/\s[|–—-]\s|\s:\s/)[0];
    if (first && first.length >= 2 && first.length <= 40) return first;
    return domain.split('.')[0].replace(/^\w/, (c) => c.toUpperCase());
}

export function subpageLinks($, pageUrl, domain, limit = 6) {
    const found = new Set();
    $('a[href]').each((_, a) => {
        if (found.size >= limit) return;
        try {
            const u = new URL($(a).attr('href'), pageUrl);
            if (!/^https?:$/.test(u.protocol) || registrableDomain(u.hostname.replace(/^www\./, '')) !== domain) return;
            if (SKIP_PATH.test(u.pathname) || u.pathname === '/' || u.pathname === new URL(pageUrl).pathname) return;
            if (SUBPAGE.test(`${$(a).text()} ${u.pathname}`)) { u.hash = ''; found.add(u.toString()); }
        } catch { /* bad link */ }
    });
    return [...found];
}

