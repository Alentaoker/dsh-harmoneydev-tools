// Default-data-path tests must never read or write the user's running DSH profile.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const root = mkdtempSync(join(tmpdir(),'dsh-e2e-test-profile-'));
process.env.DSH_HOME = root;
process.env.E2E_TELEMETRY_DISABLED = '1';
test.after(() => rmSync(root,{recursive:true,force:true}));
