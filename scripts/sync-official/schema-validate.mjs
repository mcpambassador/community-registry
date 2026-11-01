// Schema validation for mapped entries (job 1 only: uses ajv from the lockfile).
import fs from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export function makeValidator(schemaPath = new URL('../../schema/registry.schema.json', import.meta.url)) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
  return entry => (validate({ schema_version: '1.0', mcps: [entry] }) ? null : ajv.errorsText(validate.errors, { dataVar: 'entry' }).slice(0, 300));
}
