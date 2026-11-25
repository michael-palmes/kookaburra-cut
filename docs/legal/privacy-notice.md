# Kookaburra Cut privacy notice

> **The maintainer's own notice. Not legal advice.** No lawyer has reviewed
> it.

This is the legal form of [privacy.md](../privacy.md). Sections 3 to 5 name
their source in that page or in [SECURITY.md](../../SECURITY.md), which hold
the file or command behind every claim about the app. The notice lives in the
repository, so each release's tag holds the version that applied to it.

## 1. Who I am

1.1 Kookaburra Cut is free and open source software, made and maintained by
Michael Palmes, an individual in South Australia. In this notice "I" and "me"
mean him. There is no company or trading entity behind it, and nothing is
sold: no customers, no payments, no accounts and no support agreements. The
terms for the app and its code are the licence files,
[LICENSE-MIT](../../LICENSE-MIT) or [LICENSE-APACHE](../../LICENSE-APACHE).

1.2 Contact me about privacy at `privacy@kookaburracut.com`. Security
problems go to `security@kookaburracut.com` or a private report on the
repository's Security tab
([SECURITY.md, "Reporting a vulnerability"](../../SECURITY.md#reporting-a-vulnerability)).

1.3 This notice covers the Kookaburra Cut app, the website
`kookaburracut.com`, and contacting me.

## 2. In short

2.1 **The app collects no personal data.** It has no account, no telemetry and
no crash reporting, and nothing phones home. I run no server the app talks to,
so there is nothing for me to receive.

2.2 **The website keeps no record of your visit**: no access log, no
analytics, no cookies and no forms. Only a request the server fails to handle
can leave a line in its error log (section 6.3).

2.3 **I hold only what you choose to send me**: an issue, a security report or
an email.

2.4 **You can check the app yourself** (section 4).

Source: [privacy.md, "Nothing leaves your Mac unless you start it"](../privacy.md#nothing-leaves-your-mac-unless-you-start-it).

## 3. What the app keeps on your Mac

3.1 The app stores your work and its own data on your Mac only: your
workspace (`~/Kookaburra Cut` by default) with your projects, themes, brands,
fonts and exports; caches of decoded frames and previews; your settings; the
key that signs your packs, in your login Keychain and never synchronised; and
the agent files written into each project. The app opens no website; cookies
and storage that 0.24.0 or earlier kept for websites you allowed in a scene
are deleted the next time it starts.

3.2 None of it is sent to me. You control it: Settings ▸ Storage clears the
caches, and deleting a project moves it to the Trash.

3.3 The app's own caches, settings and agent folders are readable by your
macOS account alone and skipped by Spotlight. Your projects are as readable to
other accounts on the Mac as any file in your home folder. Protection at rest
is FileVault's and your account password's; the app adds no encryption of its
own.

Sources: [privacy.md, "What the app keeps on your Mac, and how to clear it"](../privacy.md#what-the-app-keeps-on-your-mac-and-how-to-clear-it);
[SECURITY.md, "On the Mac"](../../SECURITY.md#on-the-mac) and
["Saved secrets"](../../SECURITY.md#saved-secrets).

## 4. Why you can check that the app collects nothing

4.1 The app's source code is public, under the MIT License or the Apache
License 2.0.

4.2 The app window's content security policy lets it connect only to itself
and local data, never to an outside host, and scene code you allow runs behind
the same rule (`src-tauri/tauri.conf.json`, `security.csp`;
`src/stage/realmGuard.ts`).

4.3 The app's Rust code links no HTTP client of its own. The only network code
is Tauri's and the updater's, and the ffmpeg in a release is built with
networking switched off (`src-tauri/Cargo.toml`;
`scripts/build-ffmpeg-sidecar.sh`).

4.4 Each release is built by the repository's public workflow from a signed
tag, and its build provenance attestation ties the app you download to that
source (`.github/workflows/release.yml`).

4.5 An organisation can force the update check and the Claude launchers off
with a configuration profile ([mdm.md](../mdm.md)), and any
outbound firewall or network log on the Mac shows the same: no connection
unless a person starts one of the paths in section 5.

Sources: [SECURITY.md, "What leaves the Mac"](../../SECURITY.md#what-leaves-the-mac),
["Release integrity"](../../SECURITY.md#release-integrity) and
["Managed preferences"](../../SECURITY.md#managed-preferences).

## 5. When the app connects to others

Three things can reach the internet. Each one starts with you, and none of them
reaches me.

| What | Who receives it | What they receive | How to stop it |
| --- | --- | --- | --- |
| Update check | GitHub, or your organisation's own server | One request for the latest release file, at launch and then about once a day while the app is open if you left the first-run switch on, or when you choose Check for Updates. No identifiers and nothing about your use or your Mac; like any website, GitHub sees the request's IP address | The first-run switch, Settings ▸ Updates, or a configuration profile |
| Update install | GitHub, or your organisation's own server | A download request for the signed update, only when you press Install and relaunch | Press Later; a profile can turn update checks off |
| Edit with Claude | The Claude desktop app on your Mac, then Anthropic under your own account | The project folder's path and a starter prompt, sent only when you press Enter in that app; Claude Code then sends project files to Anthropic as you work | Don't press it; a profile can turn it off |

5.1 GitHub and Anthropic handle that data under their own
privacy terms, as their own controllers. GitHub names GitHub, Inc. or GitHub
B.V. as controller of what it collects from visitors, IP addresses included
[S6].

5.2 I have no access to it. GitHub shows me a running download count for
each release file and 14 days of aggregate traffic, never who downloaded or
visited [S7][S8].

5.3 Two buttons open a fixed web page in your browser (the Claude download
page and the privacy page on GitHub). Nothing about you is added to either
address. The app never opens or contacts `kookaburracut.com`.

Sources: [privacy.md, "Nothing leaves your Mac unless you start it"](../privacy.md#nothing-leaves-your-mac-unless-you-start-it)
and ["What the Claude integration sends"](../privacy.md#what-the-claude-integration-sends);
[SECURITY.md, "What leaves the Mac"](../../SECURITY.md#what-leaves-the-mac).

## 6. The website

6.1 `kookaburracut.com` is the project's home page: one page, with no account
or sign-in, and nothing sold.

6.2 **Hosting.** The site runs on a DigitalOcean server in Sydney, Australia,
over HTTPS. Cloudflare provides its DNS only: it answers lookups for the
domain name and never carries the site's traffic.

6.3 **Visitor logs.** The kookaburracut.com web server keeps no access log:
it does not record your IP address, the pages you visit or your browser for
any request. If the server fails to handle a request, for example while the
site is briefly unavailable, its error log can record the time, your IP
address and the address you requested; that log stays on the server until the
server software is next rebuilt, with no fixed deletion date.

6.4 **Analytics, cookies and other hosts.** None. The site runs no analytics,
sets no cookie and uses no local storage. Its content security policy lets
your browser load only from the site itself, which serves its own fonts, so
no other host learns of your visit.

6.5 **The download button** links to GitHub Releases. GitHub sees you only if
you click it, under its own privacy terms [S6]. The site looks up the latest
release on its server, never from your browser.

6.6 **Forms.** There is no form and no mailing list.

## 7. When you contact me

7.1 **What I collect.** Only what you send: your GitHub username and what you
write in an issue or a security report, or your name, email address and
message if you email me.

7.2 **Why.** To answer you, fix the problem and keep a record of the fix. I
don't use it for marketing, sell it or share it, except as section 7.4 says.

7.3 **Who sees it.** A GitHub issue is public. A security report is a draft
advisory that only you, the maintainer and anyone the maintainer adds to it
can see, until a fix is published [S9].

7.4 **Who holds it for me.** GitHub hosts issues and reports, in the United
States, under its own terms. Mail to `privacy@` and `security@kookaburracut.com`
is forwarded by Cloudflare Email Routing to my Gmail mailbox, which Google
hosts under its own terms; nothing is stored on the domain itself.

7.5 **How long.** Issues and published advisories stay on GitHub as the
project's public record; you can edit your own comments there. Emails are kept
for 2 years after the last message in their thread, then deleted.

Source: [SECURITY.md, "Reporting a vulnerability"](../../SECURITY.md#reporting-a-vulnerability).

## 8. The GDPR and the UK GDPR

8.1 **In the app I am neither controller nor processor.** I never receive,
access or store personal data you handle in the app, so I don't decide why or
how it is processed (GDPR Article 4(7)) and don't process it on your behalf
(Article 4(8)) [S5]. There is no processing for Article 28 to govern, so
there is no data processing agreement to sign, and no subprocessor
([subprocessors.md](../subprocessors.md)).

8.2 **Your organisation is the controller** of personal data in its projects,
such as people in footage or names in copy. The app processes it on your
organisation's own Macs, under its control. For your own duties of data
protection by design (Article 25) and security (Article 32): the app sends
nothing unless a person starts it, and a configuration profile can force each
path off ([mdm.md](../mdm.md)).

8.3 **When you contact me, I am the controller** of what I receive (section
7). My lawful basis is my legitimate interest in answering you and fixing the
app (Article 6(1)(f)).

8.4 **Transfers.** Nothing goes from the app to me. What you send me is held
in Australia, with GitHub in the United States and with Google, which hosts my
mailbox; email passes through Cloudflare on its way there. The website runs in
Australia.

## 9. The Australian Privacy Principles

9.1 Whether or not the Australian Privacy Principles bind me [S1][S2], I
follow them as below.

9.2 The statutory tort for serious invasions of privacy, in force since 10
June 2025, applies whether or not the principles bind me [S3].

9.3 The app makes no decision about anyone by computer program, so the
automated decision disclosures that APP 1 requires from 10 December 2026 have
nothing to describe [S4].

| Principle | How I meet it |
| --- | --- |
| APP 1, open and transparent management | This notice, [privacy.md](../privacy.md) and [SECURITY.md](../../SECURITY.md), all public and versioned with the app |
| APP 2, anonymity and pseudonymity | The app needs no account or name. You can report an issue under a GitHub username of your choice |
| APP 3, collection of solicited information | I collect only what you send me (section 7): nothing through the app, and through the website only an error-log line when the server fails a request (section 6.3) |
| APP 4, unsolicited information | Personal information sent to me that I don't need is deleted or, in a public issue, removed on request |
| APP 5, notice of collection | This notice, published with the [support policy](../support-policy.md) before anyone contacts me |
| APP 6, use and disclosure | Used only to answer you and fix the app (section 7.2) |
| APP 7, direct marketing | None |
| APP 8, cross-border disclosure | GitHub in the United States holds issues and reports, Cloudflare forwards email and Google hosts the mailbox it reaches (section 7.4) |
| APP 9, government identifiers | None collected |
| APP 10, quality | You can correct what you sent at any time |
| APP 11, security | Security reports stay private until a fix ships (section 7.3); I delete what I no longer need (section 7.5) |
| APP 12, access | Ask me (section 1.2) and I'll give you what I hold about you |
| APP 13, correction | Ask me, or edit your own GitHub comments |

## 10. Your rights and complaints

10.1 You may ask for access to, correction of or deletion of what I hold about
you, or object to how I use it, by contacting me (section 1.2). I reply
within one month.

10.2 If you are unhappy with my reply, you can complain to the Office of the
Australian Information Commissioner (`oaic.gov.au`), to the data protection
authority where you live in the EU (GDPR Article 77), or to the UK
Information Commissioner's Office (`ico.org.uk`).

## 11. Changes

11.1 If a release changes what the app sends or keeps, this notice,
[privacy.md](../privacy.md) and [SECURITY.md](../../SECURITY.md) change in the
same release, and the changelog says so. A change to the website's hosting,
analytics or forms changes section 6 before it goes live.

## Sources

Checked on 9 November 2026.

- S1. Privacy Act 1988, sections 6D and 6EA (the current compilation): https://www.legislation.gov.au/C2004A03712/latest/text
- S2. OAIC, the Australian Privacy Principles quick reference: https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-quick-reference; opting in: https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/opting-in-to-the-privacy-act
- S3. OAIC, statutory tort for serious invasions of privacy: https://www.oaic.gov.au/privacy/your-privacy-rights/more-privacy-rights/statutory-tort-for-serious-invasions-of-privacy
- S4. Privacy and Other Legislation Amendment Act 2024, section 2 and Schedule 1 Part 15: https://www.legislation.gov.au/C2024A00128/asmade/text
- S5. GDPR, Articles 2, 3, 4, 6, 12, 13, 25, 27, 28, 30, 32, 49 and 77, and Recital 23: https://gdpr-info.eu/
- S6. GitHub General Privacy Statement: https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
- S7. GitHub REST API, release assets (`download_count`): https://docs.github.com/en/rest/releases/assets
- S8. GitHub, viewing traffic to a repository: https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository
- S9. GitHub, privately reporting a vulnerability: https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately; repository advisories: https://docs.github.com/en/rest/security-advisories/repository-advisories
