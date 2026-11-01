import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { classifyRole, extractPeople, looksLikeName, pickContacts } from '../people.js';
import { decodeCfEmail, emailKind, extractEmails, findLinks, matchesPerson, relevantEmails } from '../emails.js';
import { passes, scoreStartup } from '../qualify.js';
import { isCompanySite, pickLinkedinResult, registrableDomain } from '../sites.js';
import { companyName, subpageLinks } from '../helpers.js';

const teamPage = `<html><body><h1>Meet the team</h1>
<div class="grid">
  <div class="card"><h3>Asha Rao</h3><p>Co-founder &amp; CEO</p><a href="https://www.linkedin.com/in/asharao">in</a></div>
  <div class="card"><h3>Vikram Shah</h3><p>Co-founder, CTO</p></div>
  <div class="card"><h3>Meera Nair</h3><p>Head of People</p></div>
  <div class="card"><h3>Karan Iyer</h3><p>Founding Engineer</p></div>
  <div class="card"><h3>Dev Patel</h3><p>Software Engineer</p></div>
</div></body></html>`;

test('roles: founders, CEO and hiring leads count; founding engineers and others do not', () => {
    assert.equal(classifyRole('Co-founder & CEO').kind, 'founder');
    assert.equal(classifyRole('Head of People').kind, 'hiring');
    assert.equal(classifyRole('Talent Acquisition Lead').kind, 'hiring');
    assert.equal(classifyRole('Managing Director').kind, 'ceo');
    assert.equal(classifyRole('Founding Engineer'), null);
    assert.equal(classifyRole('Software Engineer'), null);
    assert.equal(looksLikeName('Asha Rao'), true);
    assert.equal(looksLikeName('Meet the team'), false);
    assert.equal(looksLikeName('Join Our Team'), false);
});

test('team cards: names and titles are paired, with LinkedIn when linked', () => {
    const people = extractPeople(load(teamPage));
    const byName = Object.fromEntries(people.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(byName).sort(), ['Asha Rao', 'Meera Nair', 'Vikram Shah']);
    assert.equal(byName['Asha Rao'].kind, 'founder');
    assert.equal(byName['Asha Rao'].linkedinUrl, 'https://www.linkedin.com/in/asharao');
    assert.equal(byName['Meera Nair'].kind, 'hiring');
});

test('name and title in one line, and JSON-LD founders', () => {
    const one = extractPeople(load('<ul><li>Rohan Gupta, Founder &amp; CEO</li><li>Contact us, Support</li></ul>'));
    assert.equal(one.length, 1);
    assert.equal(one[0].name, 'Rohan Gupta');
    const ld = extractPeople(load('<script type="application/ld+json">{"@type":"Organization","name":"Acme","founder":[{"@type":"Person","name":"Isha Menon","sameAs":["https://linkedin.com/in/isham"]}]}</script>'));
    assert.equal(ld[0].name, 'Isha Menon');
    assert.equal(ld[0].kind, 'founder');
    assert.equal(ld[0].linkedinUrl, 'https://linkedin.com/in/isham');
});

test('who to write to: founder leads, hiring lead is the backup, unless preferred', () => {
    const people = extractPeople(load(teamPage));
    const a = pickContacts(people);
    assert.equal(a.primary.name, 'Asha Rao'); // founder and CEO beats a plain founder
    assert.equal(a.alternate.name, 'Meera Nair');
    const b = pickContacts(people, { preferHiringLead: true });
    assert.equal(b.primary.name, 'Meera Nair');
    assert.equal(pickContacts([]).primary, undefined);
});

test('emails: mailto, obfuscated and Cloudflare-protected addresses are found; junk is dropped', () => {
    const cf = [...'hello@acme.in'].map((c) => c.charCodeAt(0));
    const key = 0x5a;
    const hex = [key, ...cf.map((c) => c ^ key)].map((n) => n.toString(16).padStart(2, '0')).join('');
    assert.equal(decodeCfEmail(hex), 'hello@acme.in');
    const html = `<a href="mailto:Asha@acme.in?subject=Hi">Mail</a><span>careers [at] acme [dot] in</span>
      <a data-cfemail="${hex}">[email protected]</a><img src="logo@2x.png"><p>sentry@sentry.io you@example.com</p>`;
    const emails = extractEmails(load(html));
    assert.ok(emails.includes('asha@acme.in'));
    assert.ok(emails.includes('careers@acme.in'));
    assert.ok(emails.includes('hello@acme.in'));
    assert.ok(!emails.some((e) => /sentry|example|png/.test(e)));
});

test('email kinds, name matching and company-domain filter', () => {
    assert.equal(emailKind('careers@acme.in'), 'hiring');
    assert.equal(emailKind('founders@acme.in'), 'founders');
    assert.equal(emailKind('hello@acme.in'), 'general');
    assert.equal(emailKind('asha@acme.in'), 'personal');
    assert.equal(matchesPerson('asha@acme.in', 'Asha Rao'), true);
    assert.equal(matchesPerson('asha.rao@acme.in', 'Asha Rao'), true);
    assert.equal(matchesPerson('arao@acme.in', 'Asha Rao'), true);
    assert.equal(matchesPerson('hello@acme.in', 'Asha Rao'), false);
    assert.deepEqual(relevantEmails(['a@acme.in', 'b@sentry.io', 'c@gmail.com', 'd@mail.acme.in'], 'acme.in'), ['a@acme.in', 'c@gmail.com', 'd@mail.acme.in']);
    const links = findLinks(load('<a href="/careers">Join us</a><a href="/contact">Contact</a><a href="https://www.linkedin.com/company/acme/">in</a>'), 'https://acme.in/');
    assert.equal(links.careersUrl, 'https://acme.in/careers');
    assert.equal(links.companyLinkedin, 'https://www.linkedin.com/company/acme/');
});

test('startup score: right industry and young passes; big or old or off-topic fails', () => {
    const base = { keywords: ['fintech'], minFoundedYear: 2015, locations: ['India'] };
    const good = scoreStartup(load('<title>Acme | Fintech for small businesses</title><body><h1>We are building payments</h1><p>Seed funded, backed by angels. Founded in 2021 in Bengaluru, India. Fintech fintech.</p></body>'), base);
    assert.equal(passes(good, 4), true);
    const old = scoreStartup(load('<title>Old Fintech</title><body>Fintech company founded in 2003, a startup.</body>'), base);
    assert.equal(old.tooOld, true);
    assert.equal(passes(old, 1), false);
    const big = scoreStartup(load('<title>BigBank fintech</title><body>Fintech. A global leader, listed on NSE, Fortune 500 partner.</body>'), base);
    assert.equal(passes(big, 1), false);
    const off = scoreStartup(load('<title>Bakery</title><body>Cakes and bread, startup vibes, seed funded.</body>'), base);
    assert.equal(passes(off, 1), false);
});

test('only real company sites are candidates; helpers read names and subpages', () => {
    assert.equal(isCompanySite('https://acme.co.in/about'), true);
    assert.equal(isCompanySite('https://www.crunchbase.com/organization/acme'), false);
    assert.equal(isCompanySite('https://inc42.com/startups/x'), false);
    assert.equal(isCompanySite('https://iitb.ac.in/'), false);
    assert.equal(isCompanySite('https://acme.in/', ['acme.in']), false);
    assert.equal(registrableDomain('careers.acme.co.in'), 'acme.co.in');
    assert.equal(companyName(load('<title>Acme Pay | Payments for all</title>'), 'acmepay.in'), 'Acme Pay');
    const links = subpageLinks(load('<a href="/about">About</a><a href="/team">Team</a><a href="/blog/post">Blog</a><a href="https://other.com/team">x</a><a href="/files/deck.pdf">Deck</a>'), 'https://acme.in/', 'acme.in');
    assert.deepEqual(links, ['https://acme.in/about', 'https://acme.in/team']);
});

test('gmail-only keeps just Gmail addresses', () => {
    const all = ['asha@acme.in', 'asha.rao@gmail.com', 'x@googlemail.com', 'y@yahoo.com'];
    assert.deepEqual(relevantEmails(all, 'acme.in', { gmailOnly: true }), ['asha.rao@gmail.com', 'x@googlemail.com']);
    assert.equal(relevantEmails(all, 'acme.in').length, 4);
});

test('address patterns: detected from a published address, and used for suggestions', async () => {
    const { patternFor, guessAddresses } = await import('../emails.js');
    assert.equal(patternFor('Vikram Shah', 'vikram.shah@acme.in'), 'first.last');
    assert.equal(patternFor('Vikram Shah', 'vshah@acme.in'), 'flast');
    assert.equal(patternFor('Vikram Shah', 'vikram@acme.in'), 'first');
    assert.equal(patternFor('Vikram Shah', 'hello@acme.in'), null);
    assert.deepEqual(guessAddresses('Asha Rao', 'acme.in', 'first.last'), ['asha.rao@acme.in']);
    assert.deepEqual(guessAddresses('Asha Rao', 'acme.in'), ['asha@acme.in', 'asha.rao@acme.in']);
    assert.deepEqual(guessAddresses('Madonna', 'acme.in'), []);
});

test('a founder card that links their own website gives that link, not social profiles', () => {
    const html = '<div><h3>Asha Rao</h3><p>Co-founder &amp; CEO</p><a href="https://www.linkedin.com/in/asha">in</a><a href="https://x.com/asha">x</a><a href="https://asharao.dev">Website</a></div>';
    const [p] = extractPeople(load(html));
    assert.equal(p.websiteUrl, 'https://asharao.dev');
    assert.equal(p.linkedinUrl, 'https://www.linkedin.com/in/asha');
});

test('LinkedIn search results: only a profile matching both the name and the company is used', () => {
    const who = { name: 'Asha Rao', company: 'Paywise', domain: 'paywise.in' };
    const hits = [
        { url: 'https://www.linkedin.com/company/paywise', title: 'Paywise | LinkedIn', description: '' },
        { url: 'https://in.linkedin.com/in/asha-rao-123?trk=x', title: 'Asha Rao - Co-founder & CEO - Paywise | LinkedIn', description: 'Bengaluru' },
    ];
    assert.equal(pickLinkedinResult(hits, who), 'https://in.linkedin.com/in/asha-rao-123');
    assert.equal(pickLinkedinResult([{ url: 'https://www.linkedin.com/in/asha-rao-9', title: 'Asha Rao - Teacher - Springfield School | LinkedIn', description: '' }], who), '');
    assert.equal(pickLinkedinResult([{ url: 'https://www.linkedin.com/in/rao-9', title: 'Paywise | LinkedIn', description: 'Rao' }], who), '');
    assert.equal(pickLinkedinResult([], who), '');
    assert.equal(pickLinkedinResult(hits, { ...who, name: 'Madonna' }), '');
});

test('UI labels and places are not read as people (the "Due Date" bug)', () => {
    for (const bad of ['Due Date', 'Read More', 'Learn More', 'Privacy Policy', 'New Delhi', 'Get Started', 'Book Demo', 'Latest News', 'Case Studies']) {
        assert.equal(looksLikeName(bad), false, bad);
    }
    for (const good of ['Asha Rao', 'Vikram Shah', 'Meera Nair', 'Rohan Gupta']) assert.equal(looksLikeName(good), true, good);
    const html = '<div><h3>Due Date</h3><p>Co-founder</p></div><div><h3>Asha Rao</h3><p>Founder &amp; CEO</p></div>';
    const names = extractPeople(load(html)).map((p) => p.name);
    assert.deepEqual(names, ['Asha Rao']);
});

test('non-company sites such as .org bodies are not candidates', () => {
    assert.equal(isCompanySite('https://www.iaea.org/'), false);
    assert.equal(isCompanySite('https://danbrisebois.com/'), true);
});

test('search queries carry no -site operators', async () => {
    const { buildQueries } = await import('../sites.js');
    const qs = buildQueries({ keywords: ['fintech'], locations: ['India'] });
    assert.ok(qs.length >= 3);
    assert.ok(qs.every((q) => !q.includes('-site:')));
});

test('location evidence: .in domain, +91, Indian city, or location text; none means no', async () => {
    const { locationEvidence } = await import('../qualify.js');
    assert.equal(locationEvidence('hello world', 'acme.in', ['India']), true);
    assert.equal(locationEvidence('call +91 98765 43210', 'acme.com', ['India']), true);
    assert.equal(locationEvidence('our office in bengaluru', 'acme.io', ['India']), true);
    assert.equal(locationEvidence('maternity care in ontario canada', 'aspenmaternity.ca', ['India']), false);
    const html = '<title>Acme fintech</title><body>We are building payments. Seed funded. Founded in 2021. Fintech fintech. Toronto, Canada.</body>';
    const q = scoreStartup(load(html), { keywords: ['fintech'], locations: ['India'], host: 'acme.com' });
    assert.equal(q.locationOk, false);
    assert.equal(passes(q, 1, { requireLocation: true }), false);
    assert.equal(passes(q, 1, { requireLocation: false }), true);
});
