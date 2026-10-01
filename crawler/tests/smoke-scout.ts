// Smoke test: the scout and scout-promote CLIs, end to end, fully offline.
// A local http server plays both the aggregator page and a fake Ollama; the
// CLIs run as real child processes against temp files. No signing keys, no
// Tokoro API, no external network. Needs a local Chromium for playwright.
// Run from crawler/: npm run smoke:scout
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { parseCandidates } from '../src/scout/candidates.js';
import { parseFestivalsConfig } from '../src/radar/festivals-config.js';

const CRAWLER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log('      ', detail);
    failures++;
  }
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn('npx', ['tsx', ...args], {
      cwd: CRAWLER_DIR,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const chatBodies: string[] = [];
  let listHits = 0;
  let extraCandidate = false;
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/list') {
      listHits++;
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><title>Festival list</title></head><body>
<h1>Small festivals 2027</h1>
<p>Terraforma, Known Fest, Invented Fest and Series Season are all worth a look this summer.</p>
<ul>
<li><a href="http://127.0.0.1:${port}/f/terra">Terraforma</a></li>
<li><a href="http://127.0.0.1:${port}/f/known">Known Fest</a></li>
<li><a href="https://www.facebook.com/somefest">Social page</a></li>
</ul></body></html>`);
    } else if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => {
        chatBodies.push(body);
        const content = JSON.stringify({
          candidates: [
            {
              name: 'Terraforma',
              url: `http://127.0.0.1:${port}/f/terra`,
              why: 'Electronic and experimental in a villa park',
            },
            {
              name: 'Known Fest',
              url: `http://127.0.0.1:${port}/f/known`,
              why: 'already on the watchlist',
            },
            {
              name: 'Invented Fest',
              url: `http://127.0.0.1:${port}/f/does-not-exist`,
              why: 'url not on the page',
            },
            { name: 'Series Season', why: 'no url' },
            ...(extraCandidate
              ? [{ name: 'Brand New', why: 'second wave' }]
              : []),
          ],
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model: 'fake', message: { content } }));
      });
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-scout-'));
  try {
    const f = {
      sources: path.join(tmp, 'scout-sources.yaml'),
      candidates: path.join(tmp, 'candidates.yaml'),
      state: path.join(tmp, 'scout-state.json'),
      festivals: path.join(tmp, 'festivals.yaml'),
      logs: path.join(tmp, 'logs'),
    };
    const taste = 'SMOKE-TASTE tiny weird festivals only';
    await fs.writeFile(
      f.sources,
      `taste: "${taste}"\nsources:\n  - name: "Local agg"\n    url: ${base}/list\n    browser: chrome\n`
    );
    await fs.writeFile(
      f.festivals,
      `# my watchlist\nfestivals:\n  - url: ${base}/f/known\n    name: Known Fest\n`
    );

    // Minimal env: no signing keys, no real LLM keys.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LLM_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: base,
      LLM_MODEL: 'fake-model',
    };
    const scoutArgs = [
      'src/scout.ts',
      '--sources',
      f.sources,
      '--candidates',
      f.candidates,
      '--state',
      f.state,
      '--festivals',
      f.festivals,
      '--logs-dir',
      f.logs,
    ];

    const browserMissing = (r: RunResult) =>
      /Executable doesn't exist|browserType\.launch|npx playwright install/.test(
        r.stdout + r.stderr
      );

    // a. debug run
    const dbg = await runCli([...scoutArgs, '--debug'], env);
    if (dbg.code !== 0 && browserMissing(dbg)) {
      console.log('SKIP: no browser available');
      console.log((dbg.stdout + dbg.stderr).slice(-1500));
      return;
    }
    check('a. debug run exits 0', dbg.code === 0, dbg.stdout + dbg.stderr);
    check(
      'a. debug stdout lists the new candidates and says nothing was written',
      dbg.stdout.includes('Terraforma') &&
        dbg.stdout.includes('nothing was written'),
      dbg.stdout
    );
    check(
      'a. debug wrote no candidates, state or logs',
      !(await exists(f.candidates)) &&
        !(await exists(f.state)) &&
        !(await exists(f.logs))
    );
    const prompt = chatBodies.join('\n');
    check('a. LLM was called once', chatBodies.length === 1, chatBodies.length);
    check('a. prompt contains the taste text', prompt.includes(taste));
    check(
      'a. prompt contains the Terraforma link',
      prompt.includes(`Terraforma | ${base}/f/terra`)
    );
    check(
      'a. prompt lists the already-known festival names',
      prompt.includes('Already known festivals (do not return these):') &&
        prompt.includes('Known Fest')
    );
    check(
      'a. prompt does not contain the facebook link',
      !prompt.includes('facebook.com')
    );

    // b. real run
    const r1 = await runCli(scoutArgs, env);
    check('b. real run exits 0', r1.code === 0, r1.stdout + r1.stderr);
    const c1 = parseCandidates(await fs.readFile(f.candidates, 'utf-8'));
    const byName = (n: string) => c1.find(c => c.name === n);
    check(
      'b. candidates are exactly Terraforma, Invented Fest, Series Season',
      c1
        .map(c => c.name)
        .sort()
        .join('|') === 'Invented Fest|Series Season|Terraforma',
      c1.map(c => c.name)
    );
    check(
      'b. Terraforma keeps its url',
      byName('Terraforma')?.url === `${base}/f/terra`
    );
    check(
      'b. Invented Fest has its url dropped',
      byName('Invented Fest') !== undefined &&
        byName('Invented Fest')?.url === undefined
    );
    check(
      'b. Series Season has no url',
      byName('Series Season') !== undefined &&
        byName('Series Season')?.url === undefined
    );
    check(
      'b. all candidates pending',
      c1.every(c => c.status === 'pending')
    );
    const state1 = JSON.parse(await fs.readFile(f.state, 'utf-8')) as Record<
      string,
      { status: string }
    >;
    const keys = Object.keys(state1);
    check(
      'b. state has u:/n: keys, all pending',
      keys.some(k => k.startsWith('u:')) &&
        keys.some(k => k.startsWith('n:')) &&
        keys.every(k => state1[k].status === 'pending') &&
        keys.includes('n:terraforma') &&
        keys.includes('n:invented fest') &&
        keys.includes('n:series season'),
      keys
    );
    const readLog = async () =>
      (await fs.readFile(path.join(f.logs, 'runs.jsonl'), 'utf-8'))
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as Record<string, unknown>);
    const log1 = await readLog();
    check(
      'b. one scout run-log record (sources_total 1, candidates_new 3)',
      log1.length === 1 &&
        log1[0].kind === 'scout' &&
        log1[0].sources_total === 1 &&
        log1[0].candidates_new === 3,
      log1
    );

    // c. second run
    const text1 = await fs.readFile(f.candidates, 'utf-8');
    const stateText1 = await fs.readFile(f.state, 'utf-8');
    const r2 = await runCli(scoutArgs, env);
    check('c. second run exits 0', r2.code === 0, r2.stdout + r2.stderr);
    const c2 = parseCandidates(await fs.readFile(f.candidates, 'utf-8'));
    check(
      'c. candidates unchanged (3 entries)',
      c2.length === 3 && JSON.stringify(c2) === JSON.stringify(c1),
      c2.length
    );
    const log2 = await readLog();
    check(
      'c. second run-log record has candidates_new 0',
      log2.length === 2 && log2[1].candidates_new === 0,
      log2
    );
    check(
      'c. a run that adds nothing leaves candidates.yaml and scout-state.json byte-identical',
      (await fs.readFile(f.candidates, 'utf-8')) === text1 &&
        (await fs.readFile(f.state, 'utf-8')) === stateText1
    );

    // d. approve / reject, promote
    const setStatus = (text: string, name: string, status: string) => {
      const blocks = text.split(/\n(?=  - )/);
      return blocks
        .map(b =>
          b.includes(`name: ${name}\n`)
            ? b.replace(/^( {4}| {2}- )?(\s*)status: \w+/m, m =>
                m.replace(/status: \w+/, `status: ${status}`)
              )
            : b
        )
        .join('\n');
    };
    let edited = await fs.readFile(f.candidates, 'utf-8');
    edited = setStatus(edited, 'Terraforma', 'approved');
    edited = setStatus(edited, 'Invented Fest', 'rejected');
    await fs.writeFile(f.candidates, edited);
    const edC = parseCandidates(edited);
    check(
      'd. (setup) status edits applied',
      edC.find(c => c.name === 'Terraforma')?.status === 'approved' &&
        edC.find(c => c.name === 'Invented Fest')?.status === 'rejected' &&
        edC.find(c => c.name === 'Series Season')?.status === 'pending',
      edC.map(c => [c.name, c.status])
    );

    const pr = await runCli(
      [
        'src/scout-promote.ts',
        '--candidates',
        f.candidates,
        '--state',
        f.state,
        '--festivals',
        f.festivals,
      ],
      env
    );
    check('d. promote exits 0', pr.code === 0, pr.stdout + pr.stderr);
    const festText = await fs.readFile(f.festivals, 'utf-8');
    check(
      'd. festivals.yaml keeps its leading comment',
      festText.startsWith('# my watchlist'),
      festText.slice(0, 80)
    );
    const fests = parseFestivalsConfig(festText).festivals;
    const terra = fests.find(x => x.url.includes('/f/terra'));
    check(
      'd. watchlist now has 2 festivals incl. Terraforma active with notes from why',
      fests.length === 2 &&
        terra !== undefined &&
        terra.status === 'active' &&
        terra.notes === 'Electronic and experimental in a villa park',
      fests
    );
    const c3 = parseCandidates(await fs.readFile(f.candidates, 'utf-8'));
    check(
      'd. inbox now contains only Series Season',
      c3.length === 1 && c3[0].name === 'Series Season',
      c3.map(c => c.name)
    );
    const state3 = JSON.parse(await fs.readFile(f.state, 'utf-8')) as Record<
      string,
      { status: string }
    >;
    check(
      'd. state: Terraforma approved, Invented Fest rejected, Series Season pending',
      state3['n:terraforma']?.status === 'approved' &&
        state3['n:invented fest']?.status === 'rejected' &&
        state3['n:series season']?.status === 'pending',
      state3
    );

    // e. third scout run
    const r3 = await runCli(scoutArgs, env);
    check('e. third scout run exits 0', r3.code === 0, r3.stdout + r3.stderr);
    const c4 = parseCandidates(await fs.readFile(f.candidates, 'utf-8'));
    const log3 = await readLog();
    check(
      'e. nothing new: inbox still only Series Season, candidates_new 0',
      c4.length === 1 &&
        c4[0].name === 'Series Season' &&
        log3.length === 3 &&
        log3[2].candidates_new === 0,
      { c4: c4.map(c => c.name), log: log3[2] }
    );

    // f. a hand-added candidate (only a name) survives a run that adds something
    const beforeHand = await fs.readFile(f.candidates, 'utf-8');
    await fs.writeFile(f.candidates, beforeHand + '  - name: Hand Added\n');
    extraCandidate = true;
    const r4 = await runCli(scoutArgs, env);
    check(
      'f. run with a hand-added entry exits 0',
      r4.code === 0,
      r4.stdout + r4.stderr
    );
    const c5 = parseCandidates(await fs.readFile(f.candidates, 'utf-8'));
    check(
      'f. hand-added candidate survives and the new one is appended',
      c5.map(c => c.name).join('|') === 'Series Season|Hand Added|Brand New',
      c5.map(c => c.name)
    );
    extraCandidate = false;

    // g. missing LLM configuration: fail before fetching anything
    const tmp2 = path.join(tmp, 'g');
    await fs.mkdir(tmp2);
    const g = {
      candidates: path.join(tmp2, 'candidates.yaml'),
      state: path.join(tmp2, 'scout-state.json'),
      logs: path.join(tmp2, 'logs'),
    };
    const hitsBefore = listHits;
    const rg = await runCli(
      [
        'src/scout.ts',
        '--sources',
        f.sources,
        '--candidates',
        g.candidates,
        '--state',
        g.state,
        '--festivals',
        f.festivals,
        '--logs-dir',
        g.logs,
      ],
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LLM_PROVIDER: 'openrouter',
      }
    );
    check(
      'g. no LLM key: exit 1 with the preflight message',
      rg.code === 1 &&
        (rg.stdout + rg.stderr).includes('cannot set up the LLM'),
      rg.stdout + rg.stderr
    );
    check(
      'g. nothing fetched, nothing written',
      listHits === hitsBefore &&
        !(await exists(g.candidates)) &&
        !(await exists(g.state)) &&
        !(await exists(g.logs)),
      { listHits, hitsBefore }
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await new Promise<void>(r => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }

  if (failures > 0) {
    console.log(`\n${failures} smoke check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
