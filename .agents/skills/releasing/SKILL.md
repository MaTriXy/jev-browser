---
name: releasing
description: >
  Releases this package to npm and GitHub. Use when cutting a new version of
  @jkudish/jev-browser, bumping versions, writing changelogs, publishing to npm, tagging
  releases, or troubleshooting a publish that did not go as expected.
---

# Releasing @jkudish/jev-browser

Two destinations, one gate. The agent stages the npm release; only Joey can
approve it (passkey, npmjs.com Staged Packages tab). Everything else is
mechanical and exact.

## Sequence

1. Bump  in package.json. Add a  section to CHANGELOG.md
   with user-visible changes only. No internal task ids, no private names.
2. Sync the lockfile: 
> @jkudish/jev-browser@0.2.0 prepare
> npm run build


> @jkudish/jev-browser@0.2.0 build
> tsc


up to date, audited 123 packages in 2s

35 packages are looking for funding
  run `npm fund` for details

8 vulnerabilities (1 low, 6 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.. A name or version
   mismatch between package.json and package-lock breaks 
> @jkudish/jev-browser@0.2.0 prepare
> npm run build


> @jkudish/jev-browser@0.2.0 build
> tsc


added 122 packages, and audited 123 packages in 5s

35 packages are looking for funding
  run `npm fund` for details

8 vulnerabilities (1 low, 6 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details. in CI.
3. Commit, push, and wait for CI green. Do not release from a red build.
4. Stage the npm release: . Record the staged
   version and sha. Staging requires the NPM_TOKEN credential already
   configured; it never needs 2FA.
5. STOP. Ask Joey to approve the staged package at npmjs.com (Staged Packages
   tab, passkey). This is the human gate; nothing ships without it.
6. After approval, tag the exact commit that was packed (the one staged in
   step 4), not HEAD, which may have moved:
   
7. Create the GitHub release from that tag with the changelog section as notes
   and the install command: .
8. Verify:  shows the new version, and
   the release page renders.

## Rules and traps

- Staged publishing cannot create a brand-new package. The first version of
  any new package must be published interactively by Joey
  (, browser passkey). Everything after that stages.
- Registry propagation lags roughly 5 to 10 minutes after approval. A 404
  from 
@jkudish/jev-browser@0.2.0 | MIT | deps: 11 | versions: 2
A Jev-driven browser agent as an MCP tool: give it a task and a start URL; it navigates with typed Choice actions, a typed-input cascade, and stop/stuck safety gates.
https://github.com/jkudish/jev-browser#readme

keywords: mcp, model-context-protocol, typesafe, jev, browser, agent, playwright, automation

bin: jev-browser

dist
.tarball: https://registry.npmjs.org/@jkudish/jev-browser/-/jev-browser-0.2.0.tgz
.shasum: a942981dd0e2b9b07d1373c2e78e8b820578deb7
.integrity: sha512-+k7claB7WJY4fpo8yqgMbdMh3cHvVibSjPTXmf2Bpr+/jbGIuI6qUSO6mIyq8HQe82dKzfhqG1iNpMForCP1+w==
.unpackedSize: 97.8 kB

dependencies:
@ai-sdk/anthropic: ^2.0.0
@ai-sdk/google: ^1.2.0
@ai-sdk/openai-compatible: ^1.0.0
@ai-sdk/openai: ^2.0.0
@modelcontextprotocol/sdk: ^1.17.0
@typesafe-ai/sdk: ^0.6.0
ai: ^5.0.0
playwright: ^1.55.0
turndown-plugin-gfm: ^1.0.2
turndown: ^7.2.0
zod: ^3.25.0

maintainers:
- jkudish <joey@jkudish.com>

dist-tags:
latest: 0.2.0

published 30 minutes ago by jkudish <joey@jkudish.com> or  right after publish is propagation, not breakage.
  Do not diagnose it as a packaging bug.
- npx caches failed resolutions. After a propagation window, clear
   before concluding the package is broken.
- Tag, tarball, and registry version must agree to the byte. If docs land
  after staging, they ship in the next release; retagging a published version
  is never correct.
- The npm README comes from the tarball at stage time, not from GitHub HEAD.
- Never republish a version that already exists on the registry.

## Verification checklist

- CI green on the release commit.
- No staged packages found. shows the staged version and sha.
- Joey approved;  returns it.
- Tag points at the packed sha; GitHub release exists on that tag.
- Repo: https://github.com/jkudish/jev-browser
