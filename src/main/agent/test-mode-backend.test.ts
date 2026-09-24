import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effort } from '../../shared/domain'
import { createTestModeAgentBackend, UnscriptedAgentError } from './test-mode-backend'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createTestModeAgentBackend', () => {
  it('fails loudly when a session starts, since nothing scripts it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const backend = createTestModeAgentBackend()
    const options = {
      cwd: '/tmp/acme-api',
      model: 'claude-model',
      effort: Effort.High,
      resumeSessionId: null,
      systemPromptAppend: '',
      mcpServers: {},
    }

    expect(() => backend.start(options)).toThrow(UnscriptedAgentError)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Glade test mode: An agent session started in \/tmp/))
  })
})
