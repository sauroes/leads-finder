import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { discoverCompanySites, findLinkedinProfiles, hostOf, isCompanySite, registrableDomain } from './sites.js';
import { passes, qualifyWithLlm, scoreStartup } from './qualify.js';
import { extractPeople, extractPeopleWithLlm, pickContacts } from './people.js';
import { companyName, subpageLinks } from './helpers.js';
import { emailKind, extractEmails, findLinks, guessAddresses, matchesPerson, patternFor, rankEmails, relevantEmails } from './emails.js';

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const {
        industryKeywords = [], locations = ['India'], companyWebsites = [], maxCompanies = 30, maxSearchPages = 2,
        startupScoreMin = 4, minFoundedYear = 2015, requireLocationMatch = true, excludeDomains = [], onlyWithContact = true, preferHiringLead = false, useSearch = true, onlyGmail = false, followPersonalSites = true, guessEmails = false, findLinkedin = true,
        llmQualify = false, anthropicApiKey, llmModel = 'claude-haiku-5-5', proxyConfiguration,
    } = input;

    const keywords = industryKeywords.map(clean).filter(Boolean);
    if (!keywords.length) throw new Error('Add at least one industry keyword.');
    if (llmQualify && !anthropicApiKey) throw new Error('Turn off llmQualify or provide anthropicApiKey.');
    const llm = llmQualify ? { apiKey: anthropicApiKey, model: llmModel } : null;
    const proxy = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

    // 1. Candidate websites: yours plus search results.
    const own = companyWebsites.map((w) => { try { return new URL(/^https?:/i.test(w) ? w : `https://${w}`).origin + '/'; } catch { return null; } }).filter(Boolean);
    let found = [];
    if (useSearch) try {
        found = await discoverCompanySites({ keywords, locations, pages: maxSearchPages, excludeDomains, limit: Math.min(maxCompanies * 8, 400) });
    } catch (error) {
        if (!own.length) throw error;
        log.warning(`Search failed (${error.message}); continuing with the websites you gave.`);
    }
    const byDomain = new Map();
    for (const url of [...own, ...found]) {
        const domain = registrableDomain(hostOf(url));
        if (domain && isCompanySite(url, excludeDomains) && !byDomain.has(domain)) byDomain.set(domain, url);
    }
    // Sites you typed in are trusted even if they look like a directory.
    for (const url of own) { const d = registrableDomain(hostOf(url)); if (!byDomain.has(d)) byDomain.set(d, url); }
    if (!byDomain.size) throw new Error('No company websites found. Try other keywords or add websites yourself.');
    log.info(`Checking ${byDomain.size} company website(s).`);

    // 2. Read each homepage, keep the ones that look like startups in your industries, then read their about/team/contact pages.
    const companies = new Map();
    const stats = { candidates: byDomain.size, fetchFailed: 0, rejected: { 'no industry match': 0, 'not in target location': 0, 'founded too long ago': 0, 'looks established': 0, 'low score': 0 }, overLimit: 0 };
    let qualifiedCount = 0;

    const collect = async ($, pageUrl, rec, self) => {
        let people = extractPeople($);
        if (!people.length && llm && /team|about|founder|leader|people|company/i.test(pageUrl)) {
            try { people = await extractPeopleWithLlm(clean($('body').text()), llm); } catch (e) { log.warning(`Claude read failed on ${pageUrl}: ${e.message}`); }
        }
        for (const p of people) {
            const key = p.name.toLowerCase();
            const prev = rec.people.get(key);
            if (!prev || p.weight > prev.weight) rec.people.set(key, { ...p, sourcePage: pageUrl, linkedinUrl: p.linkedinUrl || prev?.linkedinUrl || '' });
            else if (!prev.linkedinUrl && p.linkedinUrl) prev.linkedinUrl = p.linkedinUrl;
        }
        if (followPersonalSites) {
            const queue = [];
            for (const p of people) {
                if (!['founder', 'ceo', 'hiring'].includes(p.kind) || !p.websiteUrl) continue;
                let domain; try { domain = registrableDomain(hostOf(p.websiteUrl)); } catch { continue; }
                const key = p.name.toLowerCase();
                if (!domain || domain === rec.domain || rec.personSites.has(key)) continue;
                rec.personSites.set(key, p.websiteUrl);
                queue.push({ url: p.websiteUrl, userData: { domain: rec.domain, label: 'PERSON', person: key } });
            }
            if (queue.length) await self.addRequests(queue.slice(0, 4));
        }
        for (const e of extractEmails($)) if (!rec.emails.has(e)) rec.emails.set(e, pageUrl);
        const links = findLinks($, pageUrl);
        rec.links.careersUrl ||= links.careersUrl;
        rec.links.contactFormUrl ||= links.contactFormUrl;
        rec.links.companyLinkedin ||= links.companyLinkedin;
    };

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxy,
        maxConcurrency: 8,
        maxRequestsPerMinute: 120,
        maxRequestRetries: 3,
        respectRobotsTxtFile: true,
        requestHandlerTimeoutSecs: 45,
        async requestHandler({ $, request, crawler: self }) {
            const { domain, label } = request.userData;
            const pageUrl = request.loadedUrl ?? request.url;
            let rec = companies.get(domain);
            if (label === 'PERSON') {
                // Their own website: any address shown there is theirs.
                if (rec) rec.personEmails.set(request.userData.person, extractEmails($).filter((e) => !onlyGmail || /@(gmail|googlemail)\.com$/.test(e)));
                return;
            }
            if (label === 'HOME') {
                rec = { domain, website: pageUrl, name: companyName($, domain), people: new Map(), emails: new Map(), personSites: new Map(), personEmails: new Map(), links: { careersUrl: '', contactFormUrl: '', companyLinkedin: '' } };
                const q = scoreStartup($, { keywords, minFoundedYear, locations, host: domain });
                let ok = passes(q, startupScoreMin, { requireLocation: requireLocationMatch });
                if (llm && q.hasIndustry && !q.tooOld) {
                    try {
                        const v = await qualifyWithLlm(clean($('body').text()), { keywords, ...llm });
                        rec.llm = v;
                        ok = v.isEarlyStageStartup === true && Number(v.industryFit) >= 6 && !(v.foundedYear && v.foundedYear < minFoundedYear);
                        if (v.foundedYear) q.foundedYear = v.foundedYear;
                    } catch (e) { log.warning(`Claude check failed for ${domain}: ${e.message}`); }
                }
                rec.quality = q;
                if (!ok) {
                    const why = !q.hasIndustry ? 'no industry match' : (requireLocationMatch && q.locationOk === false) ? 'not in target location' : q.tooOld ? 'founded too long ago' : q.tooBig ? 'looks established' : 'low score';
                    stats.rejected[why]++;
                    return;
                }
                if (qualifiedCount >= maxCompanies) { stats.overLimit++; return; }
                qualifiedCount++;
                companies.set(domain, rec);
                await self.addRequests(subpageLinks($, pageUrl, domain).map((url) => ({ url, userData: { domain, label: 'SUB' } })));
            }
            if (rec) await collect($, pageUrl, rec, self);
        },
        failedRequestHandler({ request }, error) {
            stats.fetchFailed++;
            log.debug(`Skipped ${request.url}: ${error.message}`);
        },
    });
    await crawler.run([...byDomain.entries()].map(([domain, url]) => ({ url, userData: { domain, label: 'HOME' } })));

    // 3. Pick the person to write to and match emails to them.
    const rank = { 'named + email': 0, named: 1, 'email only': 2, none: 3 };
    const leads = [];
    for (const rec of companies.values()) {
        const people = [...rec.people.values()];
        const { primary, alternate, reason } = pickContacts(people, { preferHiringLead });
        const emails = relevantEmails([...rec.emails.keys()], rec.domain, { gmailOnly: onlyGmail });
        const { hiringEmail, foundersEmail, generalEmail } = rankEmails(emails);
        const personEmail = (p) => (p ? emails.find((e) => matchesPerson(e, p.name)) ?? '' : '');
        const ownSite = (p) => {
            const found = p ? rec.personEmails.get(p.name.toLowerCase()) ?? [] : [];
            return found.find((e) => matchesPerson(e, p.name)) ?? found.find((e) => emailKind(e) === 'personal') ?? found[0] ?? '';
        };
        const fromSite = personEmail(primary);
        const fromOwn = fromSite ? '' : ownSite(primary);
        const email = fromSite || fromOwn;
        const emailKindLabel = fromSite ? 'published, matches name' : fromOwn ? 'published on their own website' : '';
        // Optional: a guessed company address, clearly labelled. Never used for Gmail-only runs.
        let guessedEmail = ''; let guessBasis = '';
        if (guessEmails && !onlyGmail && primary && !email) {
            const onDomain = emails.filter((e) => { const d = e.split('@')[1]; return d === rec.domain || d.endsWith(`.${rec.domain}`); });
            let pattern = null; let mailDomain = rec.domain;
            for (const person of rec.people.values()) {
                const hit = onDomain.find((e) => matchesPerson(e, person.name));
                const found = hit && patternFor(person.name, hit);
                if (found) { pattern = found; mailDomain = hit.split('@')[1]; break; }
            }
            guessedEmail = guessAddresses(primary.name, mailDomain, pattern).join(' or ');
            guessBasis = pattern ? `same pattern as a published address (${pattern})` : 'common pattern, not seen on the site';
        }
        const status = primary && email ? 'named + email' : primary ? 'named' : emails.length ? 'email only' : 'none';
        leads.push({
            company: rec.name, website: rec.website,
            industryMatch: rec.quality.matchedKeywords.join(', '), startupScore: rec.quality.score, foundedYear: rec.quality.foundedYear,
            contactStatus: status,
            contactName: primary?.name ?? '', contactTitle: primary?.title ?? '', contactReason: reason,
            email, emailKind: emailKindLabel, guessedEmail, guessBasis,
            alternateName: alternate?.name ?? '', alternateTitle: alternate?.title ?? '', alternateEmail: personEmail(alternate),
            hiringEmail, foundersEmail, generalEmail,
            linkedinUrl: primary?.linkedinUrl || rec.links.companyLinkedin, linkedinType: primary?.linkedinUrl ? 'person' : rec.links.companyLinkedin ? 'company' : '',
            careersUrl: rec.links.careersUrl, contactFormUrl: rec.links.contactFormUrl,
            sourcePage: primary?.sourcePage ?? rec.website,
            qualifyReasons: rec.quality.reasons.join('; '), aiSummary: rec.llm?.summary ?? '',
            peopleFound: people.map((p) => `${p.name} (${p.title})`).join(' | '), emailsFound: emails.join(', '),
            alternateLinkedinUrl: alternate?.linkedinUrl ?? '', linkedinSource: primary?.linkedinUrl ? 'startup website' : '',
            scrapedAt: new Date().toISOString(),
            _primary: primary, _alternate: alternate, _company: rec.name, _domain: rec.domain,
        });
    }

    // People whose profile link the startup's own site did not give: look them up through Google (public search results only).
    if (findLinkedin) {
        const wanted = [];
        for (const l of leads) {
            if (l._primary && !l._primary.linkedinUrl) wanted.push({ key: `${l._domain}|p`, name: l._primary.name, company: l._company, domain: l._domain });
            if (l._alternate && !l._alternate.linkedinUrl) wanted.push({ key: `${l._domain}|a`, name: l._alternate.name, company: l._company, domain: l._domain });
        }
        try {
            const profiles = await findLinkedinProfiles(wanted);
            for (const l of leads) {
                const p = profiles.get(`${l._domain}|p`); const a = profiles.get(`${l._domain}|a`);
                if (p) { l.linkedinUrl = p; l.linkedinType = 'person'; l.linkedinSource = 'Google search result'; }
                if (a) l.alternateLinkedinUrl = a;
            }
        } catch (error) { log.warning(`LinkedIn link search failed: ${error.message}`); }
    }
    for (const l of leads) { delete l._primary; delete l._alternate; delete l._company; delete l._domain; }
    const kept = leads.filter((l) => (!onlyWithContact || l.contactStatus !== 'none') && (!onlyGmail || l.emailsFound || l.email))
        .sort((a, b) => rank[a.contactStatus] - rank[b.contactStatus] || b.startupScore - a.startupScore);
    await Actor.pushData(kept);

    const summary = {
        ...stats, qualified: companies.size, returned: kept.length,
        withNamedContact: leads.filter((l) => l.contactName).length,
        withNamedContactAndEmail: leads.filter((l) => l.contactStatus === 'named + email').length,
        withAnyEmail: leads.filter((l) => l.emailsFound).length,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info('Done.', summary);
} catch (error) {
    log.error(`Run failed: ${error.message}`);
    throw error;
} finally {
    await Actor.exit();
}
