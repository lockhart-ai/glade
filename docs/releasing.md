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

2. **Merge** it through the merge queue. It waits on the required `ci` check, which itself gates on `static` and
   `unit` (Linux), `check-design` (macOS) and three `e2e` shard jobs (macOS) (`.github/workflows/ci.yml`) run in
   parallel.

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

Every release is signed with one self-signed certificate, common name **"Glade Self-Signed"** (#669), a stopgap
until Developer ID signing and notarisation (#633, formerly tracked as L-04 #69): macOS treats a certificate as a
new app's identity, not the signature's validity, so as long as every build uses the same certificate, a grant made
once (Open Anyway, screen recording, …) survives updates. It isn't trusted (no CA signed it), so it doesn't avoid
the right-click-Open step on first launch, and `security find-identity` never lists it as valid. So the workflow and
`scripts/sign-mac.mjs` find the certificate with `security find-certificate` (which lists by name regardless of
trust) and sign by its SHA-1 hash directly. On a developer's Mac `codesign` signs with it untrusted; on the CI runner
it won't, so there the hook also puts its throwaway keychain on the search list and trusts the certificate for code
signing in the runner's system keychain (`sudo -n`; the runner is thrown away after the job). A developer's
keychains and trust settings are never touched.

- **The certificate is Jared's:** he creates and keeps it, and puts it in the repo's Actions secrets as `CSC_LINK`
  (the `.p12`, base64-encoded) and `CSC_KEY_PASSWORD` (the `.p12`'s export password). Agents never handle it.
- **The release workflow** (`.github/workflows/release.yml`) fails before building, on every run including a dry
  run, if either secret is unset. It builds with `npm run package`, same as a local build, then verifies the result:
  `codesign --verify --deep --strict` on the app, and that its designated requirement's certificate leaf hash
  matches the certificate in `CSC_LINK` (read from the certificate itself each run, not hard-coded, since the
  certificate can be rotated). A build that's only ad-hoc signed, or signed with some other certificate, fails the
  workflow rather than publishing.
- **A local build** (`npm run package`, on any contributor's Mac) signs with the certificate only if it finds
  exactly one "Glade Self-Signed" identity in the default keychain (there if you made the certificate yourself, or
  were sent it for a signed build to test); otherwise it falls back to the ad-hoc signature electron-builder already
  makes, so the build still works without the certificate, or while it's mid-rotation. Check a local build with
  `codesign -dv` and `codesign -d -r- release/mac-arm64/Glade.app` (the designated requirement's `certificate leaf`
  line, or lack of one, says whether it signed with the certificate or ad-hoc).
- **Rotating the certificate** (making a new one with the same common name, when the old one's key or password is
  lost, say) costs users one more round of grants: the next release looks like a new app again, same as before #669.

Mechanically: electron-builder signs the app ad-hoc first (`identity: '-'` in `electron-builder.yml`, unchanged from
before #669), the same signature it always made; its `afterSign` hook (`scripts/sign-mac.mjs`) then re-signs the
whole app with the certificate when it finds exactly one, deep, replacing the ad-hoc seal throughout. electron-
builder's own certificate handling (`mac.identity` to the certificate's name, or auto-discovery from `CSC_LINK`)
isn't used, because it only matches a *trusted* identity via `security find-identity -v`, which a self-signed
certificate never is; `scripts/sign-mac.mjs` reads `GLADE_CSC_LINK`/`GLADE_CSC_KEY_PASSWORD` instead of
`CSC_LINK`/`CSC_KEY_PASSWORD` so electron-builder's own handling never sees the secrets and never tries.

On first launch, right-click Glade in Applications and choose Open (on newer macOS, if there's no Open button, click
Open Anyway in System Settings → Privacy & Security). If macOS still refuses, clear the quarantine flag:
`xattr -dr com.apple.quarantine /Applications/Glade.app`. Each release's notes repeat this for users.
