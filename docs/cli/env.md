# `testivai env`

Print this machine's part of the capture environment: what every capture records about where it came from, so you can see what your baselines will be compared against, and why two machines render the same page differently.

```bash
npx testivai env            # human-readable
npx testivai env --fonts    # also fingerprint the installed fonts (fc-list)
npx testivai env --json     # machine-readable
```

```
TestivAI capture environment (this machine)
  os:        linux 6.8.0-1017-azure x64 (ubuntu 24.04)
  ci:        github-actions (runner image ubuntu24/20251012.1.0)
  container: no
  label:     none (set TESTIVAI_ENV_LABEL to name this environment)
  fonts:     412 installed, fingerprint 9326f323d545
  policy:    environmentPolicy "warn"
```

- **os**: the platform, release and architecture; on Linux, the distro from `/etc/os-release`. The distro, not the kernel, decides the fonts and the text renderer.
- **ci**: the CI provider, and the runner image on GitHub Actions.
- **container**: whether this runs inside a container (`/.dockerenv` or `/run/.containerenv`).
- **label**: `TESTIVAI_ENV_LABEL`, a name you give this environment (for example the container image tag). A changed label counts as a rendering change.
- **fonts** (`--fonts`): how many fonts `fc-list` lists and a short hash of the list. Two machines with different fingerprints draw text differently. Not recorded per capture, since listing fonts costs a process.
- **policy**: `environmentPolicy` from `.testivai/config.json` (`warn`, `separate` or `strict`; see [how it works](../how-it-works.md#when-the-environment-changed-since-the-baseline)).

The browser, framework, adapter, capture method and render settings depend on the browser a test opens, so each capture records them in its own `metadata.json` (see the [Extension API](../extension-api.md#capture-provenance-environment-in-metadatajson)).
