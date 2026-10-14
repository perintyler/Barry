import { describe, it, expect } from 'vitest';
import { toOpenCodeMcpConfig, toOpenCodeMcpServer } from './mcp-config.js';

describe('Barry → OpenCode MCP translation', () => {
  it('maps a remote server, carrying headers', () => {
    expect(toOpenCodeMcpServer({ url: 'https://mcp.barry.rocks', headers: { Authorization: 'Bearer t' } }))
      .toEqual({ type: 'remote', url: 'https://mcp.barry.rocks', headers: { Authorization: 'Bearer t' }, codemode: false });
  });

  it('maps a local server, flattening command and args', () => {
    expect(toOpenCodeMcpServer({ command: 'node', args: ['server.js', '--port', '1'], env: { TOKEN: 'x' } }))
      .toEqual({ type: 'local', command: ['node', 'server.js', '--port', '1'], environment: { TOKEN: 'x' }, codemode: false });
  });

  it('reaches a server named as localhost over IPv4, which opencode cannot find through localhost', () => {
    expect(toOpenCodeMcpServer({ url: 'http://localhost:3901/mcp?sessionId=s1' }))
      .toEqual({ type: 'remote', url: 'http://127.0.0.1:3901/mcp?sessionId=s1', codemode: false });
    // Only the host: a path that says localhost, or a longer name, is left alone.
    expect(toOpenCodeMcpServer({ url: 'http://localhost.example:1/localhost' }))
      .toEqual({ type: 'remote', url: 'http://localhost.example:1/localhost', codemode: false });
  });

  it('omits headers and environment when absent rather than emitting undefined', () => {
    expect(toOpenCodeMcpServer({ url: 'https://x' })).toEqual({ type: 'remote', url: 'https://x', codemode: false });
    expect(toOpenCodeMcpServer({ command: 'node' })).toEqual({ type: 'local', command: ['node'], codemode: false });
  });

  it('keeps every server out of Code Mode, where its tools would run inside `execute`', () => {
    // `execute` is denied in every Barry session (its `fetch` passes network
    // bounds), so a server left in Code Mode would have no tools at all.
    for (const server of Object.values(toOpenCodeMcpConfig({ remote: { url: 'https://x' }, local: { command: 'node' } }))) {
      expect(server.codemode).toBe(false);
    }
  });

  it('drops an entry that is neither remote nor local', () => {
    expect(toOpenCodeMcpServer({})).toBeNull();
    expect(toOpenCodeMcpConfig({ broken: {}, good: { url: 'https://x' } }))
      .toEqual({ good: { type: 'remote', url: 'https://x', codemode: false } });
  });

  // Disk and runtime command spellings must produce the same MCP config; see docs/decisions/0021-telemetry-polling-and-adapter-regressions.md.
  it('agrees on the CLI and runtime spellings of the same server', () => {
    const fromDisk = toOpenCodeMcpConfig({ barry: { command: ['node'], args: ['s.js'] } });
    const fromRuntime = toOpenCodeMcpConfig({ barry: { command: 'node', args: ['s.js'] } });

    expect(fromDisk).toEqual(fromRuntime);
    expect(fromDisk).toEqual({ barry: { type: 'local', command: ['node', 's.js'], codemode: false } });
  });
});
