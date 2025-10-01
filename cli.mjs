#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStepToJson, withGeometry } from './core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`step2json — Convert STEP (.stp) to JSON

Usage:
  step2json <file.step> [--out result.json] [--indent 2] [--geom] [--unit mm|inch]

Options:
  --out <file>     Write JSON to file instead of stdout
  --indent <n>     Pretty-print JSON with indentation (default: 0)
  --geom           Enable geometry (bounding box & volume) via OCCT WASM (optional dep)
  --unit <u>       Unit normalization for geometry: mm | inch (default: mm)
  -h, --help       Show help
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--indent') args.indent = Number(argv[++i] ?? 0);
    else if (a === '--geom') args.geom = true;
    else if (a === '--unit') args.unit = (argv[++i] || 'mm').toLowerCase();
    else args._.push(a);
  }
  return args;
}

(async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args._.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = args._[0];
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: file not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const stats = fs.statSync(inputPath);

  let result = await parseStepToJson(raw, {
    fileName: path.basename(inputPath),
    fileSize: stats.size
  });

  if (args.geom) {
    try {
      result = await withGeometry(result, raw, { unit: args.unit || 'mm' });
    } catch (err) {
      // Non-fatal; keep non-geom data
      result.geometry = { error: String(err && err.message || err) };
    }
  }

  const json = JSON.stringify(result, null, Number.isFinite(args.indent) ? args.indent : 0);
  if (args.out) {
    fs.writeFileSync(args.out, json, 'utf8');
    console.log(`Wrote ${args.out}`);
  } else {
    process.stdout.write(json + '\n');
  }
})().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
