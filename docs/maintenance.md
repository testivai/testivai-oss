---
sidebar_position: 5
title: Maintenance & roadmap
---

# Maintenance & roadmap

If you're deciding whether to put a dependency in your test suite, you deserve a
straight answer about who maintains it and what happens if they stop. This page
is that answer.

## Who builds this

TestivAI is built by **[Budi Sugianto](https://github.com/mcbuddy)**, a solo
developer. There is no company behind it, no funding round, and no sales team.
TestivAI is [free to use](./philosophy.md#free-and-open-source), including
commercially.

It exists because visual regression tools kept failing the same way: a diff says
*0.4% of pixels changed* and you're left squinting at two screenshots trying to
work out whether it matters. Pairing the screenshot with the DOM and, from most
adapters, each element's computed styles turns that into a reading you can act
on: a structural change, a style-only change, likely render noise, or styles not
compared.

## Release cadence

The honest evidence, rather than a promise:

| | |
|---|---|
| First release | 20 March 2026 |
| Published registries | npm (5 packages), PyPI, RubyGems |

Current versions and every release note are on the
[releases page](https://github.com/testivai/testivai-oss/releases) — that link
stays accurate, whereas any number written here starts going stale the day it's
typed.

## What's next

The [public roadmap](https://github.com/testivai/testivai-oss/blob/main/ROADMAP.md)
lists what's missing and the order it's intended to be fixed, with rough sizing
and items marked as good community contributions. It's written as *what's
missing*, not as marketing — shipped items are marked shipped, and things that
are only a maybe say so.

**Adoption stories move items up that list.** If something blocks you, an
[issue](https://github.com/testivai/testivai-oss/issues) describing the concrete
pain is the most effective way to change priorities.

## What if maintenance stops

The question behind the question, answered plainly:

- **MIT licensed.** Fork it, vendor it, change it, ship it commercially. No
  permission needed and nothing to revoke.
- **Your baselines are yours.** They're PNG and HTML files committed in your own
  repository. Nothing lives on a server that can go away.
- **The output is a documented contract.** `visual-report/results.json` follows a
  semver-governed schema, so anything you build against it keeps working — and
  could be reimplemented against a different tool.
- **No account, no API key, no network calls.** There is no service that can be
  shut off, no billing that can lapse, and no telemetry to switch off.

The worst realistic outcome is that this project stops getting new features. The
version you pinned keeps working, offline, forever.

## Contributing

Issues and pull requests are welcome. Items marked *(community)* on the roadmap are
deliberately scoped as community-sized. The repository has a
[contributing guide](https://github.com/testivai/testivai-oss/blob/main/CONTRIBUTING.md)
and the full test suite runs on every pull request.
