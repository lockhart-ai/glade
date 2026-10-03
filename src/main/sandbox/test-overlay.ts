// Test helper: a sandbox overlay builder in the shape #445 sets out ("Grants"), standing in for P15-03's (#448) in the
// grants' tests until it lands. It builds from a made-up home folder, never the real one.
import { PermissionMode } from '../../shared/domain'
import { FolderAccess, SandboxGrantKind, type DomainGrant, type FolderGrant, type Grant } from '../../shared/sandbox'
import type { SandboxFlagSettings } from '../agent/backend'
import type { SandboxOverlayInput } from './grants'

/** The made-up home folder the overlay denies reads of. */
export const TEST_HOME = '/Users/sam'

/** The credential folder the overlay denies, even inside a granted folder. */
export const TEST_CREDENTIALS = `${TEST_HOME}/.ssh`

function isFolder(grant: Grant): grant is FolderGrant {
  return grant.kind === SandboxGrantKind.Folder
}

function isDomain(grant: Grant): grant is DomainGrant {
  return grant.kind === SandboxGrantKind.Domain
}

/**
 * The whole overlay: the sandbox's fixed parts (the root, the read denies, the credential denies, no domains) plus the
 * granted folders, and the permissions the grants become.
 */
export function testSandboxOverlay({ root, permissionMode, grants }: SandboxOverlayInput): SandboxFlagSettings {
  const folders = grants.filter(isFolder)
  const readOnly = folders.filter(({ access }) => access === FolderAccess.Read).map(({ path }) => path)
  const readWrite = folders.filter(({ access }) => access === FolderAccess.ReadWrite).map(({ path }) => path)
  const domains = grants.filter(isDomain).map(({ domain }) => domain)
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: permissionMode === PermissionMode.AllowAll,
      filesystem: {
        denyRead: [TEST_HOME, '/Users', '/Volumes'],
        allowRead: [root, ...folders.map(({ path }) => path)],
        allowWrite: [root, ...readWrite],
      },
      network: { allowedDomains: [] },
      credentials: { files: [{ path: TEST_CREDENTIALS, mode: 'deny' }] },
    },
    permissions: {
      allow: [...readOnly.map((path) => `Read(/${path}/**)`), ...domains.map((domain) => `WebFetch(domain:${domain})`)],
      additionalDirectories: readWrite,
    },
  }
}
