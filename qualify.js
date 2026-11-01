const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const STARTUP_SIGNS = [
    /\bpre-?seed\b/i, /\bseed[- ](funded|round|stage)\b/i, /\bseries\s?[ab]\b/i, /\bangel[- ]backed\b/i,
    /\bbacked by\b/i, /\by combinator\b|\byc\s?[sw]\d{2}\b/i, /\bincubat(ed|or)\b/i, /\baccelerator\b|\btechstars\b/i,
    /\bwe(?:'|’)?re building\b|\bwe are building\b/i, /\bearly[- ]stage\b/i, /\bstartup\b/i,
];
const BIG_SIGNS = [
    /\bfortune\s?500\b/i, /\bnyse\b|\bnasdaq\b/i, /\blisted on (the )?(nse|bse|nyse|nasdaq)\b/i, /\bpublicly traded\b/i,
    /\b\d{1,3},\d{3}\+?\s+employees\b/i, /\bglobal (market )?leader\b/i, /\bmultinational\b/i, /\bsince (19\d{2}|200\d)\b/i,
];

/** Heuristic check: does this homepage look like an early-stage startup in the user's industries? */
const INDIA_CITIES = /\b(india|bengaluru|bangalore|mumbai|delhi|new delhi|gurugram|gurgaon|noida|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|kochi|goa|chandigarh|indore|coimbatore|lucknow|surat|nagpur|thane|faridabad)\b|\+91[\s-]?\d/i;

/** Does the page show the startup is in the places we were asked for? (.in domain, +91 numbers, city names, or the location text.) */
export function locationEvidence(body, host, locations) {
    const wantsIndia = locations.some((l) => /india|bengal|mumbai|delhi|pune|hyderabad|chennai|goa/i.test(l));
    if (wantsIndia && (/\.in$/.test(host ?? '') || INDIA_CITIES.test(body))) return true;
    return locations.some((l) => l && body.includes(l.toLowerCase()));
}

export function scoreStartup($, { keywords, minFoundedYear = 2015, locations = [], host = '' }) {
    const head = clean([$('title').text(), $('meta[name="description"]').attr('content'), $('meta[property="og:description"]').attr('content'), $('h1').first().text()].join(' ')).toLowerCase();
    const body = clean($('body').text()).toLowerCase().slice(0, 40000);
    const reasons = [];
    let score = 0;

    const matched = keywords.filter((k) => {
        const kw = k.toLowerCase().trim();
        return kw && (head.includes(kw) || (body.split(kw).length - 1) >= 2);
    });
    const inHead = keywords.some((k) => head.includes(k.toLowerCase().trim()));
    if (inHead) { score += 3; reasons.push('industry in title/description'); }
    else if (matched.length) { score += 2; reasons.push('industry mentioned on page'); }

    const signs = STARTUP_SIGNS.filter((re) => re.test(body) || re.test(head));
    if (signs.length) { score += Math.min(4, signs.length * 2); reasons.push(`${signs.length} startup sign(s)`); }

    const yearMatch = body.match(/\b(?:founded|established|started|launched)(?: in)?\s*(20\d{2})\b/) ?? body.match(/\bsince\s+(20\d{2})\b/);
    const foundedYear = yearMatch ? Number(yearMatch[1]) : null;
    let tooOld = false;
    if (foundedYear) {
        if (foundedYear < minFoundedYear) { tooOld = true; reasons.push(`founded ${foundedYear}`); }
        else { score += 1; reasons.push(`founded ${foundedYear}`); }
    }

    const big = BIG_SIGNS.filter((re) => re.test(body));
    if (big.length) { score -= 4; reasons.push('looks like an established company'); }

    const locationOk = locations.length ? locationEvidence(body, host, locations) : true;
    if (locationOk && locations.length) { score += 1; reasons.push('location matches'); }

    return { score, reasons, foundedYear, matchedKeywords: matched, tooOld, tooBig: big.length > 0, hasIndustry: matched.length > 0, locationOk };
}

export const passes = (q, minScore, { requireLocation = false } = {}) => q.hasIndustry && !q.tooOld && !q.tooBig && q.score >= minScore && (!requireLocation || q.locationOk !== false);

/** Optional second opinion from Claude. Returns null if it cannot decide. */
export async function qualifyWithLlm(text, { keywords, apiKey, model }) {
    const prompt = `Website text:\n${text.slice(0, 7000)}\n\nTarget industries: ${keywords.join(', ')}.\n`
        + 'Return JSON only (no prose, no code fences) with keys: isEarlyStageStartup (boolean; true only for a company that is small and recently founded), '
        + 'industryFit (0 to 10, how well it fits the target industries), foundedYear (number or null), stage (string, "" if unknown), summary (max 15 words). '
        + 'Do not guess: use null or "" when the text does not say.';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Claude check failed (${res.status})`);
    const data = await res.json();
    const raw = (data.content ?? []).map((b) => b.text ?? '').join('').replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
}
