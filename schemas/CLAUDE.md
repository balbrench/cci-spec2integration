# Schema Authoring

When editing or creating files under `schemas/`:

1. All JSON Schema files must use `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
2. The `integration-ir.schema.json` is the authoritative contract between core agents and platform packs — do not add platform-specific properties.
3. Every `required` array must list only properties defined in the same `properties` block.
4. Use `$ref` for reusable definitions; place them under `$defs`.
5. Run validation after any change: `npx -y ajv-cli validate -s schemas/integration-ir.schema.json -d <your-ir-file>`.
