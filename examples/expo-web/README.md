# Example: an Expo app's web build

An Expo (SDK 58) app's **web build** (react-native-web), captured with
`@testivai/witness-playwright` on two phone profiles: Pixel 7 (Chromium) and
iPhone 13 (WebKit). Local-first like everything in TestivAI: no account, no
API key, nothing uploaded.

This is a standalone project to copy into your own repository, not a
workspace package: Expo pins its own React Native toolchain, so it is
installed on its own (with npm, like `examples/site-check`).

## Run

```bash
npm install
npx playwright install chromium webkit
npm run build:web          # expo export --platform web → dist/
npx playwright test        # first run: two new snapshots
npx testivai approve --all # commit .testivai/baselines/
npx playwright test        # later runs compare against them
npx testivai report --fail-on-diff   # the CI gate: exit 1 on a change
```

The report is `visual-report/index.html`. Snapshots are keyed per project,
`orders__pixel-7` and `orders__iphone-13`, so each phone is compared only with
its own baseline.

## The config, and why

`.testivai/config.json`:

```json
{
  "autoOpen": false,
  "elementIdAttributes": ["data-testid"],
  "volatileAttributes": ["class", "src"]
}
```

- **`elementIdAttributes: ["data-testid"]`.** react-native-web renders every
  `View` as a `div` with atomic classes (`css-g5y9jx`), so default element
  paths read `body > div > div.css-g5y9jx > div.css-g5y9jx:nth-of-type(4)`.
  `testID` becomes `data-testid`, and with this setting a change reads
  `div[data-testid="track-order"]`. Content inserted above an element no
  longer renames it, so a moved element reads as a shift. Needs
  `@testivai/witness-playwright` newer than 2.0.10.
- **`"class"` in `volatileAttributes`.** A `StyleSheet` change swaps an
  atomic class on the element. Without this, the DOM diff counts it as an
  attribute change and the snapshot does not read as style-only; the style
  check still names the element either way.
- **`"src"` in `volatileAttributes`.** Expo names its JavaScript bundle by
  content hash (`/_expo/static/js/web/index-<hash>.js`), so any code change
  changes that `<script src>` and counts as a DOM change. The trade-off: an
  `<img>` whose `src` changes is no longer a DOM change either (its pixels
  still are). react-native-web's `Image` draws with a `background-image`
  style, which the style check does cover.

`reducedMotion: 'reduce'` in `playwright.config.ts` asks the app to skip
JS-driven animations: TestivAI's stabilization freezes CSS animations, not
those.

## What CI checks

The `Expo example (react-native-web)` job in `.github/workflows/ci.yml`
installs this project with the packages built from the same commit, runs it
on both profiles, approves, runs again and passes, then recolours the
**Track order** button in `App.js`, rebuilds, and requires the gate to fail
with a style-only change on `div[data-testid="track-order"]` on both phones.

## What it cannot see

This is the web rendering of your React Native code, not the native app:

- native text, font and shadow rendering;
- `Platform.OS` branches and `.ios.js` / `.android.js` files;
- native-only modules (maps, camera, some animation libraries);
- safe areas and the keyboard.

On Chromium, the Playwright adapter captures at 1× CSS pixels whatever the
profile's device scale factor (2.625 for Pixel 7); WebKit captures at the
device scale factor ([Known limits](../../docs/guides/mobile-web.md#known-limits)).
