import { readFile, writeFile } from 'node:fs/promises';
const project = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, project), 'utf8');
const source = await read('docs/index.html');
// The Sheet supplies its own authenticated transport and needs no sample records.
const live = source.replace('<script src="demo.js"></script>', '');
await writeFile(new URL('apps-script/Index.html', project), live);
