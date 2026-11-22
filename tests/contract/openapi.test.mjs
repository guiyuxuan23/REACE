import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import { checkSchema, example, schemaNames } from '../../backend/mock/contract.mjs';

const contractUrl = new URL('../../contracts/openapi.yaml', import.meta.url);
const examplesUrl = new URL('../../contracts/examples/v1.json', import.meta.url);

test('validates OpenAPI 3.1 and resolves all links, examples and security requirements', async () => {
  const spec = await SwaggerParser.validate(fileURLToPath(contractUrl));
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(Object.keys(spec.paths).length, 8);
  for (const [path, methods] of Object.entries(spec.paths)) {
    const operation = Object.values(methods)[0];
    assert.deepEqual(operation.security, path === '/health' ? [] : [{ bearerAuth: [] }]);
    const json = Object.values(operation.responses).map(value => value.content['application/json']);
    if (operation.requestBody) json.push(operation.requestBody.content['application/json']);
    for (const content of json) {
      assert.ok(content.schema);
      assert.ok(Object.keys(content.examples).length > 0);
    }
  }
});

test('compiles the 2020-12 schemas and validates each canonical fixture', async () => {
  const examples = JSON.parse(await readFile(examplesUrl, 'utf8'));
  for (const name of schemaNames) checkSchema(name, null);
  for (const [name, { value }] of Object.entries(examples)) {
    const schema = name.startsWith('Error') ? 'ErrorResponse' : (name === 'MemoryCorrectionRequest' ? 'MemoryProposalRequest' : name);
    assert.deepEqual(checkSchema(schema, value), [], name);
  }
});

test('rejects raw media, blank turns, provisional live products and claims on inconclusive images', () => {
  assert.notEqual(checkSchema('VisionAnalyzeRequest', { ...example('VisionAnalyzeRequest'), image: 'synthetic' }).length, 0);
  const turn = example('AgentMessageRequest');
  turn.message.text = '   ';
  assert.notEqual(checkSchema('AgentMessageRequest', turn).length, 0);
  const catalog = example('ProductCatalogResponse');
  catalog.meta.source = 'live';
  assert.notEqual(checkSchema('ProductCatalogResponse', catalog).length, 0);
  const vision = example('VisionAnalysisResponse');
  vision.data.predictions.push({ label: 'left_higher_redness' });
  assert.notEqual(checkSchema('VisionAnalysisResponse', vision).length, 0);
});
