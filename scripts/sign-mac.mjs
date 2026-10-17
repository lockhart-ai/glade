// electron-builder's `afterSign` hook (electron-builder.yml): re-signs the packaged .app with the "Glade
// Self-Signed" certificate (#669), after electron-builder's own ad-hoc signing pass. docs/releasing.md has the why.
//
// `security find-identity` only lists *trusted* identities, and a self-signed certificate never is — so we can't
// ask electron-builder to find it by name (`mac.identity`) or rely on `CSC_LINK`/`CSC_KEY_PASSWORD` the normal way.
// Instead this script finds the certificate itself with `security find-certificate`, which lists by common name
// regardless of trust, and signs with its SHA-1 hash directly: `codesign` doesn't require trust either, only
// `security find-identity` does.
//
// - In CI (release.yml), GLADE_CSC_LINK/GLADE_CSC_KEY_PASSWORD hold the certificate (base64 .p12, deliberately not
//   named CSC_LINK/CSC_KEY_PASSWORD so electron-builder's own identity handling never touches it). This script
//   imports it into a throwaway keychain, finds the certificate's SHA-1 there, deep-re-signs the app with it, and
//   deletes the keychain. If the certificate can't be found there (secrets missing, or two during a rotation), it
//   throws rather than publish an ad-hoc build.
// - Locally (`npm run package`), with no GLADE_CSC_LINK, it looks for the certificate by name in the default
//   keychain (already there if you made it). If it finds none, or more than one (e.g. mid-rotation), it leaves
//   electron-builder's own ad-hoc signature in place rather than failing the build.
//
// Never prints, exports or copies the certificate's private key.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IDENTITY_NAME = 'Glade Self-Signed'

function security(args) {
  return execFileSync('/usr/bin/security', args, { encoding: 'utf8' })
}

// Lists the certificate's SHA-1 hash(es) by common name, in the given keychain if one is passed, else the default
// search list. Unlike `security find-identity -v`, this doesn't require the certificate to be trusted.
function findCertificateHashes(keychain) {
  const args = ['find-certificate', '-c', IDENTITY_NAME, '-a', '-Z']
  if (keychain) args.push(keychain)
  let output
  try {
    output = security(args)
  } catch {
    return []
  }
  const hashes = [...output.matchAll(/SHA-1 hash: ([0-9A-Fa-f]{40})/g)].map((m) => m[1].toUpperCase())
  return [...new Set(hashes)]
}

// Imports the certificate (and its private key) into a throwaway keychain so `security find-certificate` and
// `codesign` can use it, without touching any keychain a developer or CI already has. Returns the keychain's path;
// the caller must delete it.
function importCertificate(cscLink, cscKeyPassword) {
  const dir = mkdtempSync(join(tmpdir(), 'glade-sign-'))
  const keychain = join(dir, 'glade-sign.keychain-db')
  const p12Path = join(dir, 'cert.p12')
  const keychainPassword = randomBytes(32).toString('base64')
  try {
    writeFileSync(p12Path, Buffer.from(cscLink, 'base64'))
    security(['create-keychain', '-p', keychainPassword, keychain])
    security(['set-keychain-settings', keychain])
    security(['unlock-keychain', '-p', keychainPassword, keychain])
    security(['import', p12Path, '-k', keychain, '-P', cscKeyPassword ?? '', '-T', '/usr/bin/codesign'])
    security(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', keychainPassword, keychain])
    return keychain
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function deleteKeychain(keychain) {
  try {
    security(['delete-keychain', keychain])
  } catch (error) {
    console.warn(`sign-mac: could not delete the temporary keychain ${keychain}:`, error.message)
  }
}

export default async function afterSign(context) {
  const { appOutDir, packager, electronPlatformName } = context
  if (electronPlatformName !== 'darwin') return
  const appPath = join(appOutDir, `${packager.appInfo.productFilename}.app`)

  const cscLink = process.env.GLADE_CSC_LINK
  const inCI = Boolean(cscLink)
  let keychain = null
  try {
    let hashes
    if (inCI) {
      keychain = importCertificate(cscLink, process.env.GLADE_CSC_KEY_PASSWORD)
      hashes = findCertificateHashes(keychain)
    } else {
      hashes = findCertificateHashes(null)
    }

    if (hashes.length !== 1) {
      const reason = hashes.length === 0 ? 'not found' : `${hashes.length} matching certificates found, expected one`
      if (inCI) {
        throw new Error(`"${IDENTITY_NAME}" ${reason}; refusing to publish an ad-hoc build`)
      }
      console.log(`sign-mac: "${IDENTITY_NAME}" ${reason}; leaving ${appPath} ad-hoc signed`)
      return
    }

    const [hash] = hashes
    console.log(`sign-mac: signing ${appPath} with "${IDENTITY_NAME}" (${hash})`)
    const args = ['--force', '--deep', '--sign', hash]
    if (keychain) args.push('--keychain', keychain)
    args.push(appPath)
    execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' })
  } finally {
    if (keychain) deleteKeychain(keychain)
  }
}
