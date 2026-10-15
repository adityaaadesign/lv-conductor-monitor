// Turn the pipeline memory into text for the database and back.
// JSON cannot hold Map, Set or Infinity, so they are tagged:
//   { "__map": [...] }  { "__set": [...] }  { "__num": "Infinity" }

export function encodeSnapshot(value) {
  return JSON.stringify(value, (key, v) => {
    if (v instanceof Map) return { __map: [...v] };
    if (v instanceof Set) return { __set: [...v] };
    if (typeof v === 'number' && !Number.isFinite(v)) return { __num: String(v) };
    return v;
  });
}

export function decodeSnapshot(text) {
  return JSON.parse(text, (key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1) {
      if (Array.isArray(v.__map)) return new Map(v.__map);
      if (Array.isArray(v.__set)) return new Set(v.__set);
      if (typeof v.__num === 'string') return Number(v.__num);
    }
    return v;
  });
}
