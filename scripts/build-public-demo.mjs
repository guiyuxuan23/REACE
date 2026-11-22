import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const at = path => new URL(path, root);
const staticDir = 'dist/';
const view = 'apps/web/preview/';
const backend = 'backend/mock/';
const files = [[view + 'styles.css', 'styles.css'], [view + 'browser-api.mjs', view + 'browser-api.mjs'],
  [backend + 'scenarios.mjs', backend + 'scenarios.mjs']];

mkdirSync(at(staticDir + view), { recursive: true });
mkdirSync(at(staticDir + backend), { recursive: true });
cpSync(at('.trace-preview/apps'), at(staticDir + 'apps'), { recursive: true });
for (const [source, target] of files) cpSync(at(source), at(staticDir + target));
const examples = JSON.parse(readFileSync(at('contracts/examples/v1.json'), 'utf8'));
const names = ['ProductCatalogResponse', 'AgentMessageResponse', 'VisionAnalysisResponse'];
const fixtures = Object.fromEntries(names.map(name => [name, examples[name]]));
writeFileSync(at(staticDir + view + 'browser-fixtures.mjs'), `export const fixtures = ${JSON.stringify(fixtures)};\n`);
const policy = "default-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; media-src 'self' blob:; form-action 'none'";
const html = readFileSync(at(view + 'index.html'), 'utf8').replace('<html lang="zh-CN">', '<html lang="zh-CN" data-trace-mode="browser">')
  .replace(/<meta name="trace-development-token"[^>]+>/, `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
writeFileSync(at(staticDir + 'index.html'), html);
writeFileSync(at(staticDir + '.nojekyll'), '');
