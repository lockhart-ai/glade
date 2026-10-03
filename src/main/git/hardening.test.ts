/**
 * Glade's git runs on the host, outside the agent sandbox, in repositories the agent can write, config included (#487).
 * Each trap here is a repository set up as an agent could: a setting that names a command, set to a script that leaves
 * a marker file when it runs. Glade's own calls must never leave the marker, and neither may the command that springs
 * the trap when it's run with each of Glade's overrides that claims to stop it; git by itself does leave it, which is
 * what shows the trap was set.
 */
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHELL_GIT_ENV } from '../agent/scripted-shell'
import { createWorkspaceGit } from '../files/browse'
import { BASE_ARGS, createGit, execGit, gitEnv, GitCommand } from './git'
import { openTestRepos, type TestRepos } from './test-repos'

// Each test runs a few dozen real git commands: slow while the whole suite runs at once.
vi.setConfig({ testTimeout: 60_000 })

/** What stops a trap's command from running. */
enum Stop {
  /** The `-c` overrides every command starts with (`BASE_ARGS`), by themselves. */
  Overrides = 'overrides',
  /** The environment every command runs in (`gitEnv`), by itself. */
  Environment = 'environment',
  /** What `execGit` always gives the command (`COMMAND_ARGS`): only it stops this one. */
  CommandArgs = 'command-args',
}

/** A trap, set. */
interface Armed {
  /** The folders Glade's own calls are run in. */
  readonly dirs: readonly string[]
  /** Commits Glade's calls read, besides each folder's `HEAD`. */
  readonly commits?: readonly string[]
  /**
   * The git command that springs the trap, run in the first folder; null when nothing run without a terminal does.
   * With `Stop.CommandArgs`, it starts with one of Glade's commands.
   */
  readonly trigger: readonly string[] | null
  /** What the trigger reads on its standard input. */
  readonly input?: string
  /** What stops the trigger, each by itself. None: only that Glade never runs such a command. */
  readonly stoppedBy: readonly Stop[]
  /** Environment the trap needs, over the test's. */
  readonly env?: Readonly<Record<string, string>>
  /** Run before each run of the trigger: puts back what a run uses up. */
  readonly prepare?: () => void
}

interface Trap {
  /** The setting it names. */
  readonly setting: string
  arm(tools: TrapTools): Armed
}

interface TrapTools {
  readonly repos: TestRepos
  /**
   * The path of a script that leaves the marker, then runs `then` (a line of shell; nothing by default). No spaces in
   * it: git runs most of these settings through a shell.
   */
  readonly script: (then?: string) => string
}

let repos: TestRepos
let marker: string
let scripts = 0

beforeEach(() => {
  repos = openTestRepos()
  marker = join(repos.root, 'trap-sprung')
  scripts = 0
})

afterEach(() => {
  repos.close()
})

const tools: TrapTools = {
  get repos() {
    return repos
  },
  script: (then = '') => {
    scripts += 1
    const path = join(repos.root, `trap-${String(scripts)}.sh`)
    writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\n${then}\n`, { mode: 0o755 })
    return path
  },
}

/** Whether the marker was left since the last look; takes it away. */
function sprung(): boolean {
  const left = existsSync(marker)
  rmSync(marker, { force: true })
  return left
}

/**
 * The test's environment: the machine's, without its git settings (an editor, a pager, an ssh command: any of them
 * would stand in for the repository's) and without its git config.
 */
function testEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(
    ([name]) => !/^(?:GIT_.*|SSH_ASKPASS|EDITOR|VISUAL|PAGER)$/.test(name),
  )
  return {
    ...Object.fromEntries(kept),
    ...SHELL_GIT_ENV,
    HOME: repos.root,
    XDG_CONFIG_HOME: join(repos.root, 'no-config'),
    ...extra,
  }
}

/** Runs git by itself: whatever it does and however it ends. */
function runGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input = ''): void {
  spawnSync('git', args, { cwd, env, input, timeout: 30_000 })
}

/** A commit Glade's calls are asked about that no repository has. */
const MISSING = 'a'.repeat(40)

/** Every git call Glade makes (`createGit`, `createWorkspaceGit`), in a folder, about its `HEAD` and `commits`. */
async function everyCall(dir: string, commits: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const git = createGit(execGit(env))
  const workspaceGit = createWorkspaceGit(execGit(env))
  await workspaceGit.ignored(dir, readdirSync(dir))
  await workspaceGit.files(dir)
  const repo = await git.locate(dir)
  if (repo === null) throw new Error(`${dir} isn't in a repository`)
  const { head } = await git.head(repo)
  await git.branch(repo)
  await git.reflog(repo, 5)
  for (const commit of [...(head === null ? [] : [head]), ...commits, MISSING, MISSING.slice(0, 7)]) {
    await git.resolveCommit(repo.commonDir, commit)
    await git.summaries(repo.commonDir, [commit])
    await git.files(repo.commonDir, commit).catch(() => [])
    await git.fileAt(repo.commonDir, commit, 'README.md', 1024)
  }
}

/** A repository with a file changed in its second commit, and `attributes` as its `.gitattributes`. */
function changed(tools: TrapTools, name: string, attributes: string): string {
  const dir = tools.repos.repo(name, { 'notes.txt': 'one\n', '.gitattributes': attributes })
  tools.repos.sh('echo two > notes.txt && git commit -q -am "Change the notes"', dir)
  return dir
}

/** A copy of `HEAD`'s commit with `signature` as its `gpgsig` header: a signed commit, as far as git can tell. */
function signed(tools: TrapTools, dir: string, signature: readonly string[]): string {
  const [headers = '', ...message] = tools.repos.sh('git cat-file commit HEAD', dir).split('\n\n')
  const file = join(tools.repos.root, 'signed-commit')
  writeFileSync(file, `${headers}\ngpgsig ${signature.join('\n ')}\n\n${message.join('\n\n')}`)
  return tools.repos.sh(`git hash-object -t commit -w "${file}"`, dir).trim()
}

/** A file's stat changed and its contents not: the next `status` refreshes the index, and writes it if it may. */
function touched(file: string): () => void {
  let seconds = 1_000_000_000
  return () => {
    seconds += 60
    utimesSync(file, seconds, seconds)
  }
}

const LS_FILES = [GitCommand.LsFiles, '-z', '--cached', '--others', '--exclude-standard']
const STATUS = ['status', '--porcelain']
const CREDENTIAL = { trigger: ['credential', 'fill'], input: 'protocol=https\nhost=git.acme.example\n\n' }

const TRAPS: readonly Trap[] = [
  {
    setting: 'core.fsmonitor',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config core.fsmonitor ${script()}`, dir)
      return { dirs: [dir], trigger: LS_FILES, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    // Git starts a pager only when it writes to a terminal, and Glade reads it through a pipe: nothing to spring.
    setting: 'core.pager and pager.<command>',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      const pager = script('cat')
      repos.sh(`git config core.pager ${pager} && git config pager.log ${pager} && git config pager.show ${pager}`, dir)
      return { dirs: [dir], trigger: null, stoppedBy: [] }
    },
  },
  {
    setting: 'core.editor',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config core.editor ${script()}`, dir)
      return { dirs: [dir], trigger: ['commit', '--amend'], stoppedBy: [Stop.Overrides] }
    },
  },
  {
    setting: 'sequence.editor',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git commit -q --allow-empty -m "Second" && git config sequence.editor ${script()}`, dir)
      return { dirs: [dir], trigger: ['rebase', '-i', 'HEAD~1'], stoppedBy: [Stop.Overrides] }
    },
  },
  {
    setting: 'core.sshCommand',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config core.sshCommand ${script()}`, dir)
      return {
        dirs: [dir],
        trigger: ['ls-remote', 'ssh://git.acme.example/acme-api.git'],
        stoppedBy: [Stop.Overrides, Stop.Environment],
      }
    },
  },
  {
    setting: 'core.gitProxy',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config core.gitProxy ${script()}`, dir)
      return {
        dirs: [dir],
        trigger: ['ls-remote', 'git://git.acme.example/acme-api.git'],
        stoppedBy: [Stop.Environment],
      }
    },
  },
  {
    setting: 'core.hooksPath (a post-index-change hook, which a read can run)',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      const hooks = join(repos.root, 'hooks')
      mkdirSync(hooks)
      writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\n${script()}\n`, { mode: 0o755 })
      repos.sh(`git config core.hooksPath ${hooks}`, dir)
      return {
        dirs: [dir],
        trigger: STATUS,
        stoppedBy: [Stop.Overrides, Stop.Environment],
        prepare: touched(join(dir, 'README.md')),
      }
    },
  },
  {
    setting: 'a hook in .git/hooks (post-index-change)',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      mkdirSync(join(dir, '.git/hooks'), { recursive: true })
      writeFileSync(join(dir, '.git/hooks/post-index-change'), `#!/bin/sh\n${script()}\n`, { mode: 0o755 })
      return {
        dirs: [dir],
        trigger: STATUS,
        stoppedBy: [Stop.Overrides, Stop.Environment],
        prepare: touched(join(dir, 'README.md')),
      }
    },
  },
  {
    setting: 'core.alternateRefsCommand',
    arm({ repos, script }) {
      const other = repos.repo('acme-shared')
      const dir = repos.repo('acme-api')
      writeFileSync(join(dir, '.git/objects/info/alternates'), `${join(other, '.git/objects')}\n`)
      repos.sh(`git config core.alternateRefsCommand ${script()}`, dir)
      return {
        dirs: [dir],
        trigger: [GitCommand.RevList, '--alternate-refs', '--count', 'HEAD'],
        stoppedBy: [Stop.Overrides],
      }
    },
  },
  {
    // No option turns a filter off: Glade is kept from it by running no command that converts a working tree's files.
    setting: 'filter.<driver>.clean and filter.<driver>.smudge',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api', { 'notes.txt': 'one\n', '.gitattributes': '*.txt filter=acme\n' })
      const filter = script('cat')
      repos.sh(`git config filter.acme.clean ${filter} && git config filter.acme.smudge ${filter}`, dir)
      writeFileSync(join(dir, 'notes.txt'), 'two\n')
      return { dirs: [dir], trigger: STATUS, stoppedBy: [] }
    },
  },
  {
    setting: 'filter.<driver>.process',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api', { 'notes.txt': 'one\n', '.gitattributes': '*.txt filter=acme\n' })
      repos.sh(`git config filter.acme.process ${script()}`, dir)
      writeFileSync(join(dir, 'notes.txt'), 'two\n')
      return { dirs: [dir], trigger: STATUS, stoppedBy: [] }
    },
  },
  {
    setting: 'diff.external',
    arm(tools) {
      const dir = changed(tools, 'acme-api', '')
      tools.repos.sh(`git config diff.external ${tools.script()}`, dir)
      return { dirs: [dir], trigger: [GitCommand.Show, '--ext-diff', 'HEAD'], stoppedBy: [Stop.CommandArgs] }
    },
  },
  {
    setting: 'diff.<driver>.command',
    arm(tools) {
      const dir = changed(tools, 'acme-api', '*.txt diff=acme\n')
      tools.repos.sh(`git config diff.acme.command ${tools.script()}`, dir)
      return { dirs: [dir], trigger: [GitCommand.Log, '-p', '--ext-diff', '-1'], stoppedBy: [Stop.CommandArgs] }
    },
  },
  {
    setting: 'diff.<driver>.textconv',
    arm(tools) {
      const dir = changed(tools, 'acme-api', '*.txt diff=acme\n')
      tools.repos.sh(`git config diff.acme.textconv ${tools.script('cat "$1"')}`, dir)
      return { dirs: [dir], trigger: [GitCommand.Show, 'HEAD'], stoppedBy: [Stop.CommandArgs] }
    },
  },
  {
    setting: 'credential.helper and credential.<url>.helper',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config credential.helper ${script()}`, dir)
      repos.sh(`git config credential.https://git.acme.example.helper ${script()}`, dir)
      return { dirs: [dir], ...CREDENTIAL, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    setting: 'core.askPass',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config core.askPass ${script()}`, dir)
      return { dirs: [dir], ...CREDENTIAL, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    // With `log.showSignature` on, Glade's own `log` and `show` would check the signature.
    setting: 'gpg.program, with log.showSignature',
    arm(tools) {
      const dir = tools.repos.repo('acme-api')
      const commit = signed(tools, dir, [
        '-----BEGIN PGP SIGNATURE-----',
        '',
        'iQEzBAABCAAdFiEE',
        '=acme',
        '-----END PGP SIGNATURE-----',
      ])
      tools.repos.sh(`git config gpg.program ${tools.script()} && git config log.showSignature true`, dir)
      return {
        dirs: [dir],
        commits: [commit],
        trigger: [GitCommand.Log, '--show-signature', '--no-walk', commit],
        stoppedBy: [Stop.Overrides],
      }
    },
  },
  {
    setting: 'gpg.x509.program',
    arm(tools) {
      const dir = tools.repos.repo('acme-api')
      const commit = signed(tools, dir, ['-----BEGIN SIGNED MESSAGE-----', 'MIIB', '-----END SIGNED MESSAGE-----'])
      tools.repos.sh(`git config gpg.x509.program ${tools.script()}`, dir)
      return {
        dirs: [dir],
        commits: [commit],
        trigger: [GitCommand.Log, '--show-signature', '--no-walk', commit],
        stoppedBy: [Stop.Overrides],
      }
    },
  },
  {
    setting: 'gpg.ssh.program',
    arm(tools) {
      const dir = tools.repos.repo('acme-api')
      const commit = signed(tools, dir, [
        '-----BEGIN SSH SIGNATURE-----',
        'U1NIU0lHAAAAAQ==',
        '-----END SSH SIGNATURE-----',
      ])
      tools.repos.write('acme-api/signers', '')
      tools.repos.sh(
        `git config gpg.ssh.program ${tools.script()} && git config gpg.ssh.allowedSignersFile signers`,
        dir,
      )
      return {
        dirs: [dir],
        commits: [commit],
        trigger: [GitCommand.Log, '--show-signature', '--no-walk', commit],
        stoppedBy: [Stop.Overrides],
      }
    },
  },
  {
    // Git takes this one only from the user's own config, not a repository's: here that config includes a file in
    // the repository, which the agent can write.
    setting: 'uploadpack.packObjectsHook, in a file the user’s config includes',
    arm({ repos, script }) {
      const other = repos.repo('acme-shared', { 'notes.txt': 'one\n' })
      const dir = repos.repo('acme-api')
      const hook = script('exec "$@"')
      repos.sh(`git config uploadpack.packObjectsHook ${hook}`, other)
      repos.write('acme-shared/shared.gitconfig', `[uploadpack]\n\tpackObjectsHook = ${hook}\n`)
      repos.write('user.gitconfig', `[include]\n\tpath = ${join(other, 'shared.gitconfig')}\n`)
      return {
        dirs: [dir, other],
        trigger: ['fetch', other, 'main'],
        stoppedBy: [Stop.Environment],
        env: { GIT_CONFIG_GLOBAL: join(repos.root, 'user.gitconfig') },
      }
    },
  },
  {
    // Glade asks about commits a command printed: one the repository lacks would be fetched from its promisor remote.
    setting: 'remote.<name>.uploadpack, for an object a partial clone lacks',
    arm({ repos, script }) {
      const other = repos.repo('acme-shared')
      const dir = repos.repo('acme-api')
      repos.sh(`git config extensions.partialClone origin && git config remote.origin.promisor true`, dir)
      repos.sh(`git config remote.origin.url ${other} && git config remote.origin.uploadpack ${script()}`, dir)
      return {
        dirs: [dir],
        trigger: [GitCommand.CatFile, '-s', `${MISSING}:README.md`],
        stoppedBy: [Stop.Environment],
      }
    },
  },
  {
    setting: 'an ext:: remote, with protocol.ext.allow',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.sh(`git config protocol.ext.allow always && git config remote.origin.url "ext::${script()}"`, dir)
      return { dirs: [dir], trigger: ['ls-remote', 'origin'], stoppedBy: [Stop.Environment] }
    },
  },
  {
    setting: 'include.path, to a file in the working tree',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.write('acme-api/shared.gitconfig', `[core]\n\tfsmonitor = ${script()}\n`)
      repos.sh('git config include.path ../shared.gitconfig', dir)
      return { dirs: [dir], trigger: LS_FILES, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    setting: 'includeIf, to a file in the working tree',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api')
      repos.write('acme-api/shared.gitconfig', `[core]\n\tfsmonitor = ${script()}\n`)
      repos.sh(`git config "includeIf.gitdir:${dir}/.path" ../shared.gitconfig`, dir)
      return { dirs: [dir], trigger: LS_FILES, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    setting: 'a linked worktree’s own config (config.worktree)',
    arm({ repos, script }) {
      const main = repos.repo('acme-api')
      const dir = join(repos.root, 'acme-api-docs')
      repos.sh('git worktree add -q -b docs ../acme-api-docs && git config extensions.worktreeConfig true', main)
      repos.sh(`git config --worktree core.fsmonitor ${script()}`, dir)
      return { dirs: [dir, main], trigger: LS_FILES, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    // `status` runs git inside each submodule, which reads the submodule's own config.
    setting: 'a submodule’s own config',
    arm(tools) {
      const { dir, submodule } = withSubmodule(tools)
      tools.repos.sh(`git config core.fsmonitor ${tools.script()}`, submodule)
      return { dirs: [dir, submodule], trigger: STATUS, stoppedBy: [Stop.Overrides] }
    },
  },
  {
    // With `diff.submodule=diff`, a commit that moves a submodule is shown by a `git diff` run inside it, which no
    // option given to the outer command reaches.
    setting: 'diff.submodule, and a diff driver in the submodule’s config',
    arm(tools) {
      const { dir, submodule } = withSubmodule(tools)
      tools.repos.sh(`git config diff.acme.textconv ${tools.script('cat "$1"')}`, submodule)
      tools.repos.sh('echo two > notes.txt && git commit -q -am "Change the notes"', submodule)
      tools.repos.sh('git commit -q -am "Move the submodule" && git config diff.submodule diff', dir)
      return {
        dirs: [dir, submodule],
        trigger: [GitCommand.Show, '--no-textconv', 'HEAD'],
        stoppedBy: [Stop.Overrides],
      }
    },
  },
  {
    // With `log.diffMerges=remerge`, a merge's diff (`-m`) is made by merging again, with the config's merge drivers.
    setting: 'merge.<driver>.driver, with log.diffMerges',
    arm({ repos, script }) {
      const dir = repos.repo('acme-api', { 'notes.txt': 'one\ntwo\nthree\n', '.gitattributes': '*.txt merge=acme\n' })
      repos.sh('git checkout -q -b docs && printf "one\\ntwo\\nTHREE\\n" > notes.txt && git commit -q -am "Docs"', dir)
      repos.sh('git checkout -q main && printf "ONE\\ntwo\\nthree\\n" > notes.txt && git commit -q -am "Main"', dir)
      repos.sh('git merge -q --no-ff -m "Merge the docs" docs', dir)
      repos.sh(`git config merge.acme.driver "${script()} %A" && git config log.diffMerges remerge`, dir)
      return { dirs: [dir], trigger: [GitCommand.Show, '-m', 'HEAD'], stoppedBy: [Stop.Overrides] }
    },
  },
  {
    // Git clones a submodule without the repository's own config, so `protocol.ext.allow` there allows nothing: here
    // it's in a file of the repository that the user's config includes.
    setting: 'a submodule in .gitmodules with an ext:: URL',
    arm(tools) {
      const { dir } = withSubmodule(tools)
      const head = tools.repos.sh('git rev-parse HEAD', dir).trim()
      appendFileSync(join(dir, '.gitmodules'), `[submodule "tools"]\n\tpath = tools\n\turl = ext::${tools.script()}\n`)
      tools.repos.sh(
        `git update-index --add --cacheinfo 160000,${head},tools && git config protocol.ext.allow always`,
        dir,
      )
      tools.repos.write('acme-api/shared.gitconfig', '[protocol "ext"]\n\tallow = always\n')
      tools.repos.write('user.gitconfig', `[include]\n\tpath = ${join(dir, 'shared.gitconfig')}\n`)
      return {
        dirs: [dir],
        trigger: ['submodule', 'update', '--init', 'tools'],
        stoppedBy: [Stop.Environment],
        env: { GIT_CONFIG_GLOBAL: join(tools.repos.root, 'user.gitconfig') },
      }
    },
  },
  {
    // Git itself refuses a command here, and stops: nothing springs it.
    setting: 'submodule.<name>.update in .gitmodules',
    arm(tools) {
      const { dir, submodule } = withSubmodule(tools)
      appendFileSync(join(dir, '.gitmodules'), `\tupdate = !${tools.script()}\n`)
      return { dirs: [dir, submodule], trigger: null, stoppedBy: [] }
    },
  },
]

/** A repository with another as its submodule `vendor`, whose `*.txt` files have the diff driver `acme`. */
function withSubmodule({ repos }: TrapTools): { dir: string; submodule: string } {
  const library = repos.repo('acme-library', { 'notes.txt': 'one\n', '.gitattributes': '*.txt diff=acme\n' })
  const dir = repos.repo('acme-api')
  repos.sh(`git -c protocol.file.allow=always submodule add -q ${library} vendor && git commit -q -m "Add vendor"`, dir)
  return { dir, submodule: join(dir, 'vendor') }
}

describe('a repository whose config names a command', () => {
  it.each(TRAPS)('never has it run by Glade’s git: $setting', async (trap) => {
    const { dirs, commits = [], trigger, input, stoppedBy, env: extra, prepare } = trap.arm(tools)
    const env = testEnv(extra)
    const [dir = ''] = dirs

    for (const each of dirs) await everyCall(each, commits, env)
    expect(sprung()).toBe(false)
    if (trigger === null) return

    const [command, ...args] = trigger
    for (const stop of stoppedBy) {
      prepare?.()
      switch (stop) {
        case Stop.Overrides:
          runGit([...BASE_ARGS, ...trigger], dir, env, input)
          break
        case Stop.Environment:
          runGit(trigger, dir, gitEnv(env), input)
          break
        case Stop.CommandArgs: {
          const glade = Object.values(GitCommand).find((value) => value === command)
          if (glade === undefined) throw new Error(`${String(command)} isn't a command Glade runs`)
          await execGit(env)({ command: glade, args, cwd: dir, maxBytes: 1 << 20 })
          break
        }
      }
      expect(sprung(), `stopped by ${stop}`).toBe(false)
    }

    // Git by itself does run it: what the trap is there to show.
    prepare?.()
    runGit(trigger, dir, env, input)
    expect(sprung()).toBe(true)
  })

  it('names each trap’s setting once', () => {
    const settings = TRAPS.map(({ setting }) => setting)
    expect(new Set(settings).size).toBe(settings.length)
  })
})

describe('what Glade’s git never does', () => {
  it('uses no transport, whatever the config allows, and fetches no object a partial clone lacks', () => {
    const other = repos.repo('acme-shared')
    const dir = repos.repo('acme-api')
    repos.sh('git config protocol.allow always && git config protocol.file.allow always', dir)
    const env = testEnv()
    const lsRemote = (with_: NodeJS.ProcessEnv): number | null =>
      spawnSync('git', ['ls-remote', other], { cwd: dir, env: with_ }).status
    expect(lsRemote(env)).toBe(0)
    expect(lsRemote(gitEnv(env))).toBe(128)
    expect(gitEnv({ PATH: '/usr/bin', GIT_ALLOW_PROTOCOL: 'file', GIT_NO_LAZY_FETCH: '0' })).toEqual({
      PATH: '/usr/bin',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      GIT_ALLOW_PROTOCOL: '',
      GIT_NO_LAZY_FETCH: '1',
    })
  })
})

/** The folder of Glade's source, and this file's place in it. */
const SRC = join(import.meta.dirname, '..', '..')

/** The source files that may name git as a process to run: the one place Glade runs it, and the tests' own repositories. */
const MAY_RUN_GIT: ReadonlySet<string> = new Set(['main/git/git.ts', 'main/git/test-repos.ts'])

/**
 * Whether a source file starts processes and names git as one: `'git'`, a path to it, or a command line that starts
 * with it, in quotes of any kind.
 */
function runsGit(source: string): boolean {
  return /child_process|node-pty/.test(source) && /(['"`])(?:[^'"`\s]*\/)?git(?:\1|\s)/.test(source)
}

describe('the one place Glade runs git', () => {
  it('is execGit: no other source file starts a git process', () => {
    const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
    )
    expect(sources.length).toBeGreaterThan(100)
    const offenders = sources.filter((path) => runsGit(readFileSync(join(SRC, path), 'utf8')))
    expect(new Set(offenders.map((path) => relative('.', path)))).toEqual(MAY_RUN_GIT)
  })

  it('would spot a file that did', () => {
    const imported = `import { execFile, spawn } from 'node:child_process'\n`
    for (const call of [
      `execFile('git', ['status'], { cwd })`,
      `spawn("git", ['diff'])`,
      'execSync(`git status --porcelain`)',
      `execFileSync('/usr/bin/git', ['log'])`,
      `exec('git -C ' + dir + ' status')`,
    ])
      expect(runsGit(imported + call), call).toBe(true)
    // A file that starts other processes, or only talks about git.
    expect(runsGit(`${imported}execFile('/bin/sh', ['-c', command])\n// git status`)).toBe(false)
    expect(runsGit(`const command = 'git commit -q -m "Start the Acme API"'`)).toBe(false)
  })
})
