// core.mjs — parsing HEADER + entity histogram + optional geometry (OCCT WASM)

function safeMatch(re, str, idx = 1) {
  const m = re.exec(str);
  return m ? (m[idx] || '').trim() : '';
}

function extractHeader(block) {
  // Very tolerant STEP HEADER parser (ISO-10303-21)
  // We avoid strict grammar; focus on main sections.
  const desc = safeMatch(/FILE_DESCRIPTION\s*\(\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'\s*\)\s*;/si, block);
  const name = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'\s*,\s*'(.*?)'\s*\)\s*;/si, block);
  const schema = safeMatch(/FILE_SCHEMA\s*\(\s*\(\s*'(.*?)'\s*\)\s*\)\s*;/si, block);

  // break down FILE_NAME subfields loosely if present
  const fileName = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'/si, block);
  const timeStamp = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'/si, block, 2);
  const author = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)/si, block, 3);
  const org = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)/si, block, 4);
  const preprocessor = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'/si, block, 5);
  const originatingSystem = safeMatch(/FILE_NAME\s*\(\s*'(.*?)'\s*,\s*'(.*?)'\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*\(\s*'(.*?)'\s*\)\s*,\s*'(.*?)'\s*,\s*'(.*?)'/si, block, 6);

  return {
    FILE_SCHEMA: schema || undefined,
    FILE_DESCRIPTION: desc || undefined,
    FILE_NAME: fileName || undefined,
    timestamp: timeStamp || undefined,
    author: author || undefined,
    organization: org || undefined,
    preprocessor: preprocessor || undefined,
    originatingSystem: originatingSystem || undefined
  };
}

function computeEntityHistogram(stepBody) {
  // STEP entities typically appear as: #42 = ADVANCED_FACE ( ...
  // We'll count by the UPPERCASE identifier following '='
  const hist = {};
  const re = /^\s*#\d+\s*=\s*([A-Z0-9_]+)\s*\(/gm;
  let m;
  while ((m = re.exec(stepBody)) !== null) {
    const type = m[1];
    hist[type] = (hist[type] || 0) + 1;
  }
  return hist;
}

export async function parseStepToJson(raw, fileInfo = {}) {
  // Split HEADER / DATA (ENDSEC separators)
  const headerMatch = /HEADER\s*;(.*?)ENDSEC\s*;/is.exec(raw) || [];
  const dataMatch = /DATA\s*;(.*?)ENDSEC\s*;/is.exec(raw) || [];

  const headerBlock = headerMatch[1] || '';
  const dataBlock = dataMatch[1] || '';

  const header = extractHeader(headerBlock);
  const entities = computeEntityHistogram(dataBlock);

  return {
    tool: 'step2json',
    version: '0.1.0',
    file: {
      name: fileInfo.fileName || undefined,
      sizeBytes: Number.isFinite(fileInfo.fileSize) ? fileInfo.fileSize : undefined
    },
    header,
    summary: {
      totalEntities: Object.values(entities).reduce((a, b) => a + b, 0),
      uniqueTypes: Object.keys(entities).length
    },
    entities
  };
}

// (novo) withGeometry usando 'occt-import-js' oficial
export async function withGeometry(resultJson, rawStep, opts = { unit: 'mm' }) {
  // Mapear unidades para os valores esperados pela lib:
  // millimeter | centimeter | meter | inch | foot
  const unitMap = {
    mm: 'millimeter',
    millimeter: 'millimeter',
    cm: 'centimeter',
    centimeter: 'centimeter',
    m: 'meter',
    meter: 'meter',
    inch: 'inch',
    in: 'inch',
    ft: 'foot',
    foot: 'foot'
  };
  const unitKey = String(opts.unit || 'mm').toLowerCase();
  const linearUnit = unitMap[unitKey] || 'millimeter';

  let occtFactory;
  try {
    // O pacote exporta uma função (CommonJS). Em ESM, vem em `default`.
    occtFactory = (await import('occt-import-js')).default;
  } catch (e) {
    throw new Error(
      "Geometry mode requires 'occt-import-js'. Install with: npm i occt-import-js"
    );
  }

  const occt = await occtFactory(); // inicializa WASM
  // Podes passar Buffer diretamente (Node) — ou Uint8Array.
  // Se o teu 'rawStep' for string, converte:
  const fileBytes = typeof rawStep === 'string'
    ? new TextEncoder().encode(rawStep)
    : (rawStep instanceof Uint8Array ? rawStep : new Uint8Array(rawStep));

  // Passa parâmetros (deflection opcional); aqui só definimos unidade.
  const res = occt.ReadStepFile(fileBytes, { linearUnit });
  if (!res || !res.success) throw new Error('occt-import-js: failed to read STEP');

  const meshes = res.meshes || [];
  if (!meshes.length) throw new Error('occt-import-js: no meshes generated');

  // Bounding box a partir dos vértices
  let min = [ Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY ];
  let max = [ Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY ];

  for (const m of meshes) {
    const arr = (m.attributes?.position?.array) || m.vertices || m.points || [];
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], y = arr[i+1], z = arr[i+2];
      if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
    }
  }

  const dims = [ max[0]-min[0], max[1]-min[1], max[2]-min[2] ];

  // Volume aproximado por soma de tetraedros (mesh-based)
  let approxVolume = 0;
  for (const m of meshes) {
    const v = (m.attributes?.position?.array) || m.vertices || m.points || [];
    const idx = (m.index?.array) || m.indices || [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i]*3, b = idx[i+1]*3, c = idx[i+2]*3;
      const ax = v[a], ay = v[a+1], az = v[a+2];
      const bx = v[b], by = v[b+1], bz = v[b+2];
      const cx = v[c], cy = v[c+1], cz = v[c+2];
      approxVolume += (ax*(by*cz - bz*cy) - ay*(bx*cz - bz*cx) + az*(bx*cy - by*cx)) / 6.0;
    }
  }
  approxVolume = Math.abs(approxVolume);

  // Já pedimos a unidade à lib; não precisamos reconverter aqui.
  const geometry = {
    unit: linearUnit,
    bbox: { min, max },
    size: { x: dims[0], y: dims[1], z: dims[2] },
    volumeApprox: approxVolume
  };

  return { ...resultJson, geometry };
}

