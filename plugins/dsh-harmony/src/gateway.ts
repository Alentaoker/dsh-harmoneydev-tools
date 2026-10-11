const admitted = new WeakSet<Request>();
export function admittedByHarness(request: Request) { return admitted.has(request); }
export async function withHarnessAdmission(request: Request, handler: (request: Request) => Promise<Response>) {
  admitted.add(request);
  try { return await handler(request); }
  finally { admitted.delete(request); }
}
