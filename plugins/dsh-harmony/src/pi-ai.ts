import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
export { Type };
function strictObjects(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictObjects);
  const value = { ...schema };
  for (const key of ['properties', 'patternProperties']) if (value[key]) value[key] = Object.fromEntries(Object.entries(value[key]).map(([name, child]) => [name, strictObjects(child)]));
  for (const key of ['anyOf', 'oneOf', 'allOf', 'items']) if (value[key]) value[key] = strictObjects(value[key]);
  if (value.type === 'object' && value.properties && value.additionalProperties === undefined) value.additionalProperties = false;
  return value;
}
export function validateToolArguments(tool: any, call: any) {
  const schema = strictObjects(tool.parameters);
  if (!Value.Check(schema, call.arguments)) {
    const errors = [...Value.Errors(schema, call.arguments)];
    throw new Error(`Invalid ${tool.name} arguments: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  }
  return call.arguments;
}
