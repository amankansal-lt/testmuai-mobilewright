# @testmuai/mobilewright

TestMu.Ai driver for [Mobilewright](https://github.com/mobile-next/mobilewright). Runs an
existing Mobilewright suite on TestMu.Ai real devices by changing one line of config — the
tests themselves are untouched.

**Status: working.** Verified end to end on a real iPhone through a TestMu.Ai cluster — session
creation, device allocation, locators, taps, element screenshots and teardown. Android is still
unverified, and webviews need an inspectable build (see below).

## Install

```bash
npm i -D @testmuai/mobilewright
export TESTMU_USERNAME=... TESTMU_ACCESS_KEY=...   # LT_USERNAME / LT_ACCESS_KEY also work
```

```ts
// mobilewright.config.ts
import { defineConfig } from 'mobilewright';
import { testMuDriver } from '@testmuai/mobilewright';

export default defineConfig({
  testDir: './tests',
  bundleId: 'com.example.app',
  driver: testMuDriver({ app: './build/app.ipa' }),   // lt://APP_ID, a local path, or an https url
  projects: [
    { name: 'ios', use: { platform: 'ios', deviceType: 'real', deviceName: /iPhone 1[45]/, osVersion: '>=17 <19' } },
    { name: 'android', use: { platform: 'android', deviceType: 'real' } },
  ],
});
```

```bash
npx mobilewright test
```

Keep one config and switch by environment — local device by default, TestMu.Ai when
credentials are present:

```ts
if (process.env.TESTMU_USERNAME) config.driver = testMuDriver({ app: './build/app.apk' });
```

## How it works

One TestMu.Ai Appium session per Mobilewright worker slot; the session id is the pool's
`deviceId`, and workers attach to it. Each Mobilewright verb becomes a W3C WebDriver command —
`getViewHierarchy()` is `GET /source` parsed into `ViewNode`s, taps and swipes are `/actions`,
app lifecycle is `mobile:` commands, webviews are Appium contexts. Nothing is installed on the
device host: it is the same WDA / UiAutomator2 stack TestMu.Ai already runs for Appium.

Device selection needs no catalog lookup — TestMu.Ai matches `deviceName` and
`platformVersion` as regular expressions, so a Mobilewright `deviceName: /iPhone 1[45]/` passes
straight through, and an `osVersion` range becomes a major-version alternation.

## Options

| Option | Default | Notes |
|---|---|---|
| `app` / `apps` | `TESTMU_APP`, else `LT_APP` | `lt://APP_ID`, local `.apk`/`.ipa` (uploaded once per run, cached by content hash), or https url. `apps` is keyed `ios`/`android`/`ios-real`/`android-real`; an array installs helper apps as `otherApps` (max 3) |
| `username` / `accessKey` | `TESTMU_USERNAME` / `TESTMU_ACCESS_KEY`, falling back to `LT_USERNAME` / `LT_ACCESS_KEY` | |
| `build` / `project` / `name` / `tags` | build auto-detected from CI | GitHub Actions, GitLab, CircleCI, Buildkite, Bitrise, Azure, Jenkins, TeamCity |
| `idleTimeout` | `900` | raised from TestMu.Ai's 120s default because a pooled slot idles between tests; paired with a 45s keepalive ping |
| `allocationTimeout` | `900000` | covers TestMu.Ai's own device queue |
| `snapshotTuning` | `{ waitForIdleTimeout: 0, animationCoolOffTimeout: 0 }` | see below; `false` leaves server defaults |
| `visibility` | `'native'` | `'bounds'` matches mobilecli's looser semantics — see below |
| `tunnel` / `tunnelName`, `geoLocation`, `timezone`, `networkLog`, `deviceLog`, `video`, `disableAnimation`, `autoGrantPermissions`, `autoAcceptAlerts`, `autoDismissAlerts`, `appiumVersion`, `region`, `queueTimeout`, `maxDuration` | | mapped to TestMu.Ai capabilities. Network throttling is available through the `capabilities` escape hatch |
| `capabilities` / `ltOptions` | | escape hatches, merged last |
| `hubUrl` / `apiBase` / `uploadUrl` | TestMu.Ai | point `hubUrl` at a local Appium for development |

### Snapshot tuning

Mobilewright polls the hierarchy every 100ms and settles an element by comparing two
consecutive dumps, so the automation backend's own idle wait before each snapshot is redundant
work on the hot path. This driver disables it by default (`waitForIdleTimeout: 0`,
`animationCoolOffTimeout: 0`) and exposes `snapshotMaxDepth` and `customSnapshotTimeout`.
Neither the BrowserStack nor the TestingBot driver does this.

## Known behavioural differences

Verified on real hardware. All of these are properties of the underlying automation stack, not
of this package.

| Area | Behaviour |
|---|---|
| **iOS visibility** | XCUITest's `visible` is stricter than mobilecli's: an element drawn under a sibling (a SwiftUI `Stepper` over its own label) is reported invisible although it is on screen, so `getByText(...)` + `toBeVisible()` can fail where it passed locally. `visibility: 'bounds'` judges by geometry instead and restores mobilecli's behaviour. |
| **`getByType`** | Matches the raw native type, which is driver-specific by design (upstream normalizes only for `getByRole`). Appium reports `XCUIElementTypeSwitch`; mobilecli strips the prefix. Prefer `getByRole('switch')`, which works on both. |
| **`toBeChecked()` on iOS** | Works here — the parser derives checked state from a switch's `value` of `"1"`. It does **not** work against local mobilecli 1.0.11, which reports `isChecked: false`. |
| **Element screenshots** | `locator.screenshot()` is cropped to the element, scaled by the device's pixel ratio. Both competing drivers ignore `clip` and return the full screen. |
| **iOS `BACK`** | iOS has no back button; `screen.goBack()` is translated into the system left-edge back-swipe. Both competing drivers throw. |
| **Webviews** | Appium requires the WKWebView to be inspectable (a debug build, or `isInspectable = true` on iOS 16.4+). A release build exposes no context and `getByWebView()` reports no webviews. mobilecli injects directly and does not need this. |
| **`listApps()`** | Reports only apps this session launched; a cloud Appium session exposes no package list. |
| **`applyDeviceSettings()`** | A no-op — animations are a session capability (`disableAnimation`) applied at allocation. |
| **Rapid repeat taps** | Two taps in quick succession can coalesce differently than on mobilecli. Assert between them. |

## Reporting

The driver ships a `TestObserver`, so Mobilewright wires up session naming and pass/fail with
no reporter configuration. The verdict is pushed while the session is still alive (at release),
at the end of the run, from the run report: each session is judged **only by the tests that
actually ran on it** (matched through the `device.id` annotation the fixture attaches), and a
test counts as its final attempt, so a flaky-then-passed retry does not fail a session. The
push goes through `lambda-hook: setTestStatus`, then `lambda-status=`, then the REST API —
sessions are usually already released by run end, which is what the REST fallback is for.

## Development

```bash
npm run build && npm run typecheck && npm test      # 40 unit tests, no device needed
```

To exercise it against real hardware without TestMu.Ai credentials, point `hubUrl` at a local
Appium — the protocol is identical:

```ts
driver: testMuDriver({
  hubUrl: 'http://127.0.0.1:4723',
  visibility: 'bounds',
  capabilities: { 'appium:udid': '...', 'appium:bundleId': 'com.example.app' },
})
```

`DEBUG=testmu:*` logs allocation, every hub command, uploads and verdict pushes.

### Naming

Environment variables read `TESTMU_USERNAME`, `TESTMU_ACCESS_KEY`, `TESTMU_APP` and
`TESTMU_BUILD` first, then fall back to the `LT_`-prefixed names. Both are supported
indefinitely — the fallback is not a deprecation, it is what existing pipelines are already
configured with, and the two families can be mixed.

The wire protocol is deliberately **not** renamed: `lt://` app ids, the `lambda-status=` /
`lambda-hook:` executor hooks and the `*.lambdatest.com` hostnames are what the platform
actually speaks, so they stay exactly as the server expects them.

## License

Apache-2.0
