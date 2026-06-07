// IR schema IntelliSense — associates schemas/integration-ir.schema.json with
// integration-ir.yaml so editing the IR gets live validation + autocomplete, the
// same schema ajv enforces later in the pipeline.
//
// Uses the redhat.vscode-yaml programmatic API (registerContributor) so we can
// serve the schema straight from the workspace without writing user settings.
// No-ops gracefully when the YAML extension is not installed.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

const SCHEME = 'spec2integration';
const SCHEMA_URI = `${SCHEME}://schema/integration-ir`;

interface YamlExtensionApi {
  registerContributor(
    scheme: string,
    requestSchema: (resource: string) => string | undefined,
    requestSchemaContent: (uri: string) => string | Promise<string> | undefined,
    label?: string,
  ): boolean;
}

export async function registerIrSchema(repoRoot: string): Promise<void> {
  const yamlExt = vscode.extensions.getExtension('redhat.vscode-yaml');
  if (!yamlExt) {
    // YAML extension absent — IntelliSense is unavailable, but everything else works.
    return;
  }
  const api = (await yamlExt.activate()) as YamlExtensionApi | undefined;
  if (!api || typeof api.registerContributor !== 'function') return;

  const schemaPath = path.join(repoRoot, 'schemas', 'integration-ir.schema.json');
  if (!(await fileExists(schemaPath))) return;

  api.registerContributor(
    SCHEME,
    (resource: string) => (/integration-ir\.ya?ml$/i.test(resource) ? SCHEMA_URI : undefined),
    (uri: string) => (uri === SCHEMA_URI ? fs.readFile(schemaPath, 'utf-8') : undefined),
    'Spec2Integration IR',
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
