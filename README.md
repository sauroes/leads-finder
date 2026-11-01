# Startup Hiring Contact Finder

Give it industry keywords (for example fintech, edtech). It finds early-stage startups in those industries and, for each one, the person who decides on hiring, with the contact details the startup publishes on its own website.

## What it does

1. **Finds startup websites** with Google searches (Apify's Google Search Scraper) built from your keywords and locations, plus any websites you list. News sites, directories, job boards and social sites are skipped.
2. **Checks each homepage** and keeps only real matches. A site is scored on:
   - industry match: your keyword in the title or description (+3), or mentioned on the page (+2)
   - startup signs: seed, pre-seed, Series A/B, angel-backed, backed by, Y Combinator, incubator, accelerator, "we are building", early-stage, startup (+2 each, up to +4)
   - founding year: +1 if on or after your minimum, dropped if older
   - established-company signs (Fortune 500, listed on NSE/BSE/NYSE, "global leader", "since 19xx"): -4 and dropped
   - your location mentioned (+1)

   A site must match your industry, not be too old or established, and reach the score you set. The reasons are in the `qualifyReasons` column so you can tune it.
3. **Reads the about, team, contact and careers pages** of the startups that pass.
4. **Picks who to write to.** At a startup the founder or CEO decides on hiring, so they lead. A head of people, HR or talent is the backup (or the lead, if you turn on `preferHiringLead`).
5. **Matches emails.** Only addresses published on the site are used. An address is tied to a person only if it looks like theirs (asha@, asha.rao@, arao@). Otherwise you get the hiring inbox (careers@, jobs@, hr@) and the general inbox (hello@, contact@) as separate columns.

## Output

One row per startup: company, website, industry match, score, founded year, `contactStatus` (named + email, named, email only), contact name, role and why chosen, their email, backup contact, hiring inbox, general inbox, LinkedIn (a link the startup's own site gives, person or company), careers page, contact page, and the page everything was found on.

## Getting a founder's email

In this order: (1) an address on the startup's site that matches their name; (2) an address on the founder's own website, if the team page links one (`followPersonalSites`, on by default; any address shown on their own site is treated as theirs); (3) optionally, `guessEmails` suggests a likely company address such as `asha.rao@company.com`. If another person's published address shows the company's naming pattern, that pattern is used; otherwise the two most common patterns are suggested. Guesses are labelled, never checked for delivery, and some will bounce. They are not used with `onlyGmail`.

## LinkedIn links

The link comes from the startup's own team page when it shows one. If not, and `findLinkedin` is on, the actor runs a Google search for the person's name and company and uses a LinkedIn profile from the public search results, but only when the result shows both the name and the company. Nothing is fetched from LinkedIn itself. The `linkedinSource` column says which route gave the link.

## Limits

- **Nothing is guessed.** If a founder's email is not published, the `email` column is empty. Use the hiring or general inbox, or the LinkedIn link.
- **Heuristics, not certainty.** Startup detection and name/title pairing are rule-based and will make mistakes. Turn on `llmQualify` (needs an Anthropic API key) for a second opinion on each startup; the same key also lets Claude read team pages the rules cannot parse.
- **Pages that need JavaScript** to show their team or contact details look empty to this crawler.
- Search results favour sites that rank well, so very small startups may be missed. Add known websites in `companyWebsites`.
- Use the list for individual, relevant outreach, and honour any request to stop. India's data protection and anti-spam rules apply to how you use contact details.

## Setup

Input: `industryKeywords` (required), `onlyGmail`, `locations`, `companyWebsites`, `maxCompanies`, `startupScoreMin`, `minFoundedYear`, `excludeDomains`, `onlyWithContact`, `preferHiringLead`, `useSearch`, `llmQualify`, `anthropicApiKey`.

Run `npm test` for the tests.

## Troubleshooting weak results

- **Discovery is the weak step.** Google results often come back as redirect links the search actor cannot resolve, and the rest are mostly directories. The log line starting with "Search:" shows how many results were kept and why others were dropped. For better results, set `useSearch` to off and pass real startup websites in `companyWebsites` (for example the company domains from a leads export).
- **Blocked sites (403 or 429).** Keep Apify Proxy on (the default).
- **Too few results.** Turn off `requireLocationMatch`, lower `startupScoreMin`, or use broader keywords.
- **Sites that need JavaScript** show no team or contact details to this crawler.
