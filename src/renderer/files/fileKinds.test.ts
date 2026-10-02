import { describe, expect, it } from 'vitest'
import { FileFamily, FileGlyph, fileKind } from './fileKinds'

/** A name's icon as `glyph/family`. */
function kind(name: string): string {
  const { glyph, family } = fileKind(name)
  return `${glyph}/${family}`
}

describe('fileKind', () => {
  it.each([
    // Code, in blue.
    ['throttles.py', FileGlyph.Code, FileFamily.Code],
    ['App.tsx', FileGlyph.Code, FileFamily.Code],
    ['client.ts', FileGlyph.Code, FileFamily.Code],
    ['build.mjs', FileGlyph.Code, FileFamily.Code],
    ['deploy.sh', FileGlyph.Code, FileFamily.Code],
    ['index.html', FileGlyph.Code, FileFamily.Code],
    ['main.go', FileGlyph.Code, FileFamily.Code],
    // Stylesheets: a hash, in the code family.
    ['theme.css', FileGlyph.Stylesheet, FileFamily.Code],
    ['theme.scss', FileGlyph.Stylesheet, FileFamily.Code],
    // Config: braces, grey.
    ['package.json', FileGlyph.Config, FileFamily.Config],
    ['docker-compose.yml', FileGlyph.Config, FileFamily.Config],
    ['ci.yaml', FileGlyph.Config, FileFamily.Config],
    ['pyproject.toml', FileGlyph.Config, FileFamily.Config],
    ['setup.cfg', FileGlyph.Config, FileFamily.Config],
    // Data, in purple.
    ['schema.sql', FileGlyph.Database, FileFamily.Data],
    ['app.sqlite3', FileGlyph.Database, FileFamily.Data],
    ['keys.csv', FileGlyph.Database, FileFamily.Data],
    // Images, in teal.
    ['logo.png', FileGlyph.Image, FileFamily.Image],
    ['photo.jpeg', FileGlyph.Image, FileFamily.Image],
    ['icon.svg', FileGlyph.Image, FileFamily.Image],
    // Prose.
    ['README.md', FileGlyph.Docs, FileFamily.Docs],
    ['notes.txt', FileGlyph.Docs, FileFamily.Docs],
    ['guide.rst', FileGlyph.Docs, FileFamily.Docs],
  ])('%s is %s, in the %s family, by its extension', (name, glyph, family) => {
    expect(fileKind(name)).toEqual({ glyph, family })
  })

  it('knows a lockfile by its name, whatever its extension says', () => {
    for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'go.sum']) {
      expect(kind(name), name).toBe('lock/config')
    }
    for (const name of ['yarn.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'bun.lockb']) {
      expect(kind(name), name).toBe('lock/config')
    }
    // A config file that only mentions a lock isn't one.
    expect(kind('lock.json')).toBe('config/config')
    expect(kind('package.json')).toBe('config/config')
  })

  it('knows a Dockerfile by its name, in any of its forms, but not Compose’s file', () => {
    for (const name of ['Dockerfile', 'dockerfile', 'Dockerfile.dev', 'api.dockerfile', 'Containerfile']) {
      expect(kind(name), name).toBe('docker/config')
    }
    expect(kind('docker-compose.yml')).toBe('config/config')
    expect(kind('Dockerfiles.md')).toBe('docs/docs')
  })

  it('takes any name that starts with a dot for a dotfile, whatever follows', () => {
    for (const name of ['.gitignore', '.editorconfig', '.env', '.env.local', '.eslintrc.json', '.hidden.png']) {
      expect(kind(name), name).toBe('dotfile/config')
    }
  })

  it('goes by the last extension, without regard to case', () => {
    expect(kind('LOGO.PNG')).toBe('image/image')
    expect(kind('Schema.SQL')).toBe('database/data')
    expect(kind('README.MD')).toBe('docs/docs')
    expect(kind('archive.tar.gz')).toBe('file/docs')
    expect(kind('report.final.md')).toBe('docs/docs')
    expect(kind('types.d.ts')).toBe('code/code')
    expect(kind('PNPM-LOCK.YAML')).toBe('lock/config')
  })

  it('takes the prose names that have no extension for docs, and gives anything else the plain file', () => {
    for (const name of ['README', 'LICENSE', 'Licence', 'CHANGELOG', 'NOTICE', 'AUTHORS', 'CONTRIBUTING']) {
      expect(kind(name), name).toBe('docs/docs')
    }
    for (const name of ['Makefile', 'archive.zip', 'model.bin', 'weird.', 'no-extension', 'data.unknownkind', '']) {
      expect(kind(name), name).toBe('file/docs')
    }
  })

  it('gives every glyph a file that shows it', () => {
    const names = ['a.py', 'a.md', 'a.css', 'a.json', 'a.sql', 'a.png', 'a.lock', 'Dockerfile', '.npmrc', 'a.bin']
    expect(new Set(names.map((name) => fileKind(name).glyph))).toEqual(new Set(Object.values(FileGlyph)))
  })
})
