# Releasing

Each phase ends with a minor release: P1 is 0.1.0, P2 is 0.2.0, and so on. `package.json`'s `version` is the source
of truth, and a pushed tag `vX.Y.Z` builds and publishes the release (`.github/workflows/release.yml`).

## Steps

1. **Bump PR.** On a branch from `main`:

   ```sh
   npm version 0.2.0 --no-git-tag-version   # updates package.json and package-lock.json
   ```

   Add `docs/releases/v0.2.0.md`: a short, user-facing summary of what the phase delivers and how to run it. It goes at
   the top of the release notes, above GitHub's generated list of merged PRs. Its "Running it" section says where the
   logs are, from 0.9.0 on:

   ```md
   - **Logs:** `~/Library/Logs/glade/main.log`, one JSON line per event, rotated at 5 MB. They stay on your Mac;
     attach them to a bug report if you like (`docs/logs.md` says what's in them).
   ```

   Open the PR as usual.

2. **Merge** it through the merge queue. It waits on the required `ci` check, which itself gates on `static`, `unit`
   and three `e2e` shard jobs (`.github/workflows/ci.yml`) run in parallel.

3. **Tag** the merged commit on `main` and push the tag:

   ```sh
   git fetch origin
   git tag v0.2.0 <merged commit>
   git push origin v0.2.0
   ```

4. **The workflow** runs on the tag (macOS runner): it checks the tag matches `package.json`'s version and that the
   notes file exists, runs `npm ci`, typecheck and unit tests, packages with `npm run package`, and creates the GitHub
   Release with the `.dmg` and `.zip` attached. Watch it in the Actions tab.

If the release step fails after the tag is pushed, fix the cause on `main` if needed, then either rerun the workflow or
run it by hand on the tag with dry run off (`gh workflow run release.yml --ref v0.2.0 -f dry_run=false`). Delete a
half-made release first if one exists.

## Dry run

To check the build without publishing, run the workflow by hand on any branch:

```sh
gh workflow run release.yml --ref <branch> -f dry_run=true
```

It builds and packages, then uploads the `.dmg` and `.zip` as a workflow artifact (`glade-packages`) instead of creating
a release.

## Checking a packaged build

A change that can affect the packaged app (an SDK bump, Electron, electron-builder) gets checked on a local build:

```sh
npm run package
node scripts/check-packaged-claude.mjs release/mac-arm64/Glade.app
```

`check-packaged-claude` checks the bundled Claude Code binary is unpacked from `app.asar` and runs, as the release
workflow does. An SDK bump also gets one real probe of the packaged app: a small script, run by the app's own Electron as
Node, that loads the SDK from the app bundle, points it at the unpacked binary and runs one Haiku `query()` in a temp
folder:

```sh
ELECTRON_RUN_AS_NODE=1 release/mac-arm64/Glade.app/Contents/MacOS/Glade <probe.cjs> "$PWD/release/mac-arm64/Glade.app"
```

It should print a `success` result. Give the app's path in full (the probe resolves the SDK from it). Run the build
where it is: never install a test build into `/Applications`.

## Dependency updates

Dependency bumps come from Dependabot (`.github/dependabot.yml`), weekly: the Claude Agent SDK on its own, the other
npm packages (minor and patch grouped, majors one by one, except the held majors the SOP lists, which are raised by
hand), and GitHub Actions. `docs/kitten-sop.md` says how each kind is handled. Bumps land on `main` like any other PR and ship in the next release.

## Artifacts

`Glade-X.Y.Z-arm64.dmg` and `Glade-X.Y.Z-arm64.zip`, for Apple silicon only (`electron-builder.yml`). An Intel build
would need the Claude Agent SDK's x64 binary package installed alongside, so it's left out for now.

## Signing

Builds are ad-hoc signed (`identity: '-'` in `electron-builder.yml`): a sealed signature with no certificate, not
notarised. Developer ID signing and notarisation are L-04 (#69). Check a local build with
`codesign --verify --deep --strict release/mac-arm64/Glade.app`.

On first launch, right-click Glade in Applications and choose Open (on newer macOS, if there's no Open button, click
Open Anyway in System Settings → Privacy & Security). If macOS still refuses, clear the quarantine flag:
`xattr -dr com.apple.quarantine /Applications/Glade.app`. Each release's notes repeat this for users.
