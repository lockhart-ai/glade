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
   - **Logs:** `~/Library/Logs/Glade/main.log`, one JSON line per event, rotated at 5 MB. They stay on your Mac;
     attach them to a bug report if you like (`docs/logs.md` says what's in them).
   ```

   Open the PR as usual.

2. **Merge** it through the merge queue.

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
