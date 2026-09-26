import { describe, expect, it } from 'vitest'
import { commandTargets, isAmendEntry, isCommitEntry, MAX_TARGETS, printedCommits } from './commands'

const HOME = '/Users/acme'
const CWD = '/code/acme-api'

describe('commandTargets', () => {
  it('is the folder the command runs in, for a command that goes nowhere else', () => {
    expect(commandTargets('git commit -am "Fix the test"', CWD, HOME)).toEqual([CWD])
    expect(commandTargets('npm test && ./scripts/release.sh', CWD, HOME)).toEqual([CWD])
  })

  it('adds each folder the command changes to, resolved from where it is by then, and each git -C', () => {
    expect(
      commandTargets(
        'cd ../acme-api-docs && git add -A && git commit -m "Docs"; cd sub && git -C ../other commit -m x',
        CWD,
        HOME,
      ),
    ).toEqual([CWD, '/code/acme-api-docs', '/code/acme-api-docs/sub', '/code/acme-api-docs/other'])
    expect(commandTargets('git -c user.name=A -C "/code/with space" commit -m x', CWD, HOME)).toEqual([
      CWD,
      '/code/with space',
    ])
    expect(commandTargets("(cd '/tmp/wt' && git commit -m x)", CWD, HOME)).toEqual([CWD, '/tmp/wt'])
    expect(commandTargets('ls\ncd -- src', CWD, HOME)).toEqual([CWD, `${CWD}/src`])
  })

  it('expands the home folder, and skips what only the shell could work out, or a folder it has already', () => {
    expect(commandTargets('cd ~ && cd ~/code/acme-api && cd .', CWD, HOME)).toEqual([
      CWD,
      HOME,
      `${HOME}/code/acme-api`,
    ])
    expect(commandTargets('cd $HOME/code && cd `pwd`/x && cd - && cd ""', CWD, HOME)).toEqual([CWD])
    expect(commandTargets('cd "src" && cd ..', CWD, HOME)).toEqual([CWD, `${CWD}/src`])
  })

  it('stops at the most folders one command is looked at in', () => {
    const command = Array.from({ length: 20 }, (_, index) => `cd /r${String(index)}`).join(' && ')
    const targets = commandTargets(command, CWD, HOME)
    expect(targets).toHaveLength(MAX_TARGETS)
    expect(targets.slice(0, 3)).toEqual([CWD, '/r0', '/r1'])
  })
})

describe('isCommitEntry', () => {
  it('counts each way a commit is made', () => {
    for (const subject of [
      'commit: Fix the test',
      'commit (initial): Start',
      'commit (amend): Fix the test properly',
      'commit (merge): Merge branch docs',
      "merge docs/upgrade: Merge made by the 'ort' strategy.",
      "pull: Merge made by the 'ort' strategy.",
      'cherry-pick: Fix the test',
      'revert: Revert "Fix the test"',
    ]) {
      expect(isCommitEntry(subject), subject).toBe(true)
    }
  })

  it('doesn’t count HEAD moving to a commit that was there', () => {
    for (const subject of [
      'checkout: moving from main to docs',
      'reset: moving to HEAD~1',
      'merge docs: Fast-forward',
      'pull: Fast-forward',
      'rebase (pick): Fix the test',
      'rebase (finish): returning to refs/heads/main',
      'commit-ish: nothing',
      '',
    ]) {
      expect(isCommitEntry(subject), subject).toBe(false)
    }
  })

  it('tells an amend apart', () => {
    expect(isAmendEntry('commit (amend): Fix')).toBe(true)
    expect(isAmendEntry('commit: Fix')).toBe(false)
  })
})

describe('printedCommits', () => {
  it('reads each commit git printed, in order, once each: the branch, the hash and the message', () => {
    const output = [
      '[main a1b2c3d] Fix the UTC date test',
      ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      '[main (root-commit) 0f1e2d3] Start the Acme API',
      '[detached HEAD 9a8b7c6d] Try the other fix',
      '[fix/date-test a1b2c3d] Fix the UTC date test',
      'Everything up-to-date',
    ].join('\n')
    expect(printedCommits(output)).toEqual([
      { branch: 'main', hash: 'a1b2c3d', subject: 'Fix the UTC date test' },
      { branch: 'main', hash: '0f1e2d3', subject: 'Start the Acme API' },
      { branch: null, hash: '9a8b7c6d', subject: 'Try the other fix' },
    ])
  })

  it('reads nothing from output that only looks a little like it', () => {
    expect(printedCommits('[INFO] Build finished\n[main abc] Too short\n [main a1b2c3d] Indented')).toEqual([])
    expect(printedCommits('')).toEqual([])
  })
})
