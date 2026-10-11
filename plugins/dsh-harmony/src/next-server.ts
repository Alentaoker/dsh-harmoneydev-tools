/** Harmony handlers use only the standards-based Response subset of NextResponse. */
export class NextResponse extends Response {
  static json(data: unknown, init?: ResponseInit) { return Response.json(data, init); }
}
