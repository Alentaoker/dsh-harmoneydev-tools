import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
export { Type };
export function validateToolArguments(tool: any, call: any) {
  if (!Value.Check(tool.parameters, call.arguments)) {
    const errors = [...Value.Errors(tool.parameters, call.arguments)];
    throw new Error(`Invalid ${tool.name} arguments: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  }
  return call.arguments;
}
