import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const spec = JSON.parse(readFileSync(new URL('../../contracts/schemas/v1.json', import.meta.url), 'utf8'));
const examples = JSON.parse(readFileSync(new URL('../../contracts/examples/v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
ajv.addSchema(spec);

export const schemaNames = Object.keys(spec.$defs);

export function checkSchema(name, data) {
  const validate = ajv.getSchema(`${spec.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Unknown contract schema ${name}`);
  return validate(data) ? [] : validate.errors.map(({ instancePath, message }) => `${instancePath || '/'} ${message}`);
}

export function example(name) {
  if (!Object.hasOwn(examples, name)) throw new Error(`Unknown contract example ${name}`);
  return structuredClone(examples[name].value);
}
