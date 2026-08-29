/**
 * On engine-scale monorepos (Unreal Engine's source tree, hundreds of
 * thousands of files), `codegraph_explore`'s RWR graph-mass pass
 * (`computeGraphRelevance`) adds real wall-clock on top of an already
 * expensive subgraph build. `resolveGraphMassMaxFiles` gates that pass off
 * above a file-count ceiling; these tests pin the env-var parsing and confirm
 * explore still returns a sane, non-crashing answer with the pass off.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, resolveGraphMassMaxFiles } from '../src/mcp/tools';
import CodeGraph from '../src/index';

const THRESHOLD_ENV = 'CODEGRAPH_GRAPH_MASS_MAX_FILES';
const DEBUG_ENV = 'CODEGRAPH_EXPLORE_DEBUG';

function clearEnv(): void {
  delete process.env[THRESHOLD_ENV];
  delete process.env[DEBUG_ENV];
}

describe('resolveGraphMassMaxFiles', () => {
  afterEach(clearEnv);

  it('defaults to 50000 when unset', () => {
    clearEnv();
    expect(resolveGraphMassMaxFiles()).toBe(50000);
  });

  it('honors a valid override', () => {
    process.env[THRESHOLD_ENV] = '10';
    expect(resolveGraphMassMaxFiles()).toBe(10);
  });

  it('falls back to the default on a non-numeric or negative value', () => {
    for (const bad of ['abc', '-5', 'NaN']) {
      process.env[THRESHOLD_ENV] = bad;
      expect(resolveGraphMassMaxFiles()).toBe(50000);
    }
  });
});

describe('codegraph_explore — graph-mass pass skip on huge repos', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  const QUERY = 'Session method helper callSession';

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-mass-skip-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'session.ts'),
      [
        'export class Session {',
        '  method(arg: string): string {',
        '    return this.helper(arg);',
        '  }',
        '  private helper(arg: string): string {',
        '    return arg;',
        '  }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(srcDir, 'support.ts'),
      [
        "import { Session } from './session';",
        'export function callSession(s: Session) {',
        "  return s.method('hi');",
        '}',
      ].join('\n'),
    );

    clearEnv();
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    clearEnv();
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const explore = async (): Promise<string> => {
    const result = await handler.execute('codegraph_explore', { query: QUERY });
    return result.content?.[0]?.text ?? '';
  };

  it('still finds the named symbols when the graph-mass pass is skipped', async () => {
    process.env[THRESHOLD_ENV] = '0'; // this project's file count (2) is > 0, forcing skip
    const text = await explore();
    expect(text).toContain('session.ts');
    expect(text).toContain('Session');
  });

  it('reports the skip on the debug diagnostic, and stays silent about it below the threshold', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    process.env[DEBUG_ENV] = '1';
    process.env[THRESHOLD_ENV] = '0';
    await explore();
    expect(writes.join('')).toContain('relevance gate skipped — graph-mass (RWR) pass off');

    writes.length = 0;
    delete process.env[THRESHOLD_ENV]; // back to the 50000 default — this tiny project stays under it
    await explore();
    expect(writes.join('')).not.toContain('graph-mass (RWR) pass off');
  });
});
